import { Address, beginCell, Cell, internal, loadTransaction, SendMode } from "@ton/core";
import { z } from "zod";
import type { AssetId } from "../assets/payout-address.js";
import type {
  ChainPayment,
  PayoutCheckpoint,
  PayoutRequest,
  PayoutResult,
  Transfer,
} from "../chains/adapter.js";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "../money/format.js";
import { splitPayout } from "../money/payout-split.js";
import { openSecret, type SealedSecret } from "../security/secret-envelope.js";
import type { PricePort } from "./evm.js";
import {
  EXPIRY_MARGIN_SECONDS,
  findPayoutBySeqno,
  getRecentTonTransactions,
  getTonAccount,
  getTonDestination,
  loadTonWallet,
  notAWallet,
  type OutgoingMessage,
  paidExactly,
  parseTonAddress,
  readDepositWallet,
  readSeqno,
  sameTonAccount,
  sendTonMessage,
  signW5External,
  type TonApi,
  type TonWallet,
  TX_LIFETIME_SECONDS,
} from "./ton.js";

// A jetton (USDT on TON) deposit: payment listing and payout.
//
// How a jetton moves:
// - Each owner (a W5 wallet) has its own jetton wallet contract per jetton
//   master; its address comes from the master's get_wallet_address. The
//   deposit's tokens sit in the deposit's jetton wallet, not in the deposit.
// - To send, the owner sends its jetton wallet a `transfer` message carrying
//   TON for the fees. That jetton wallet sends `internal_transfer` to the
//   receiver's jetton wallet (deploying it if needed), which credits the
//   tokens, sends the receiver a notification if forward_ton_amount > 0, and
//   the unused TON as `excesses` to the response_destination.
// - internal_transfer is always bounceable (the contract decides): a
//   receiver's jetton wallet that refuses sends the tokens back.
//
// The payout, in two phases, each saved before it is sent:
// 1. top_up: the platform's TON gas wallet sends the deposit the TON its
//    payout needs (non-bounceable: before its first payout the deposit has
//    no code, and a bounceable message to it comes straight back).
// 2. transfers: the deposit (deployed by this message if needed) sends its
//    jetton wallet one `transfer` per receiver: destination, then platform.
//    These are bounceable: they are commands, not deliveries. If the jetton
//    wallet refuses one, its TON comes back and no token moved.
//    response_destination is the deposit itself: unused TON stays there,
//    and a later payout from it tops up only what is missing (as on EVM).
// "Paid" is proven by the receivers' jetton wallets: the transaction in
// which each one credited the planned amount.
//
// Since fix ticket F (owner option A), a payout that topped up the deposit
// names the gas wallet as response_destination, and its last transfer
// carries all the TON left at the deposit: every nanoton the jetton
// transfers do not use returns to the gas wallet as `excesses` in the same
// cascade of messages (the sweep, recorded as gas_sweep). The merchant is
// charged the measured cost of the payout, not the TON sent along.

// TON attached to each jetton transfer. The emulator's mainnet config used
// about 2,000,000 per transfer to a receiver with no jetton wallet yet; the
// rest comes back to the deposit.
export const JETTON_TRANSFER_TON = 20_000_000n;
// The deposit's own payout transaction: about 1,350,000 on the emulator for
// a first payout (deploys the wallet, two messages).
export const JETTON_DEPOSIT_FEE_BUDGET = 5_000_000n;
// The gas wallet's own top-up transaction: about 513,000 on the emulator.
export const GAS_WALLET_FEE_BUDGET = 2_000_000n;
// What a payout really costs, measured on @ton/sandbox 0.45.0 (its default
// config, a mainnet snapshot) for fix ticket F, 2026-11-19. The merchant is
// charged these; the TON sent along beyond them comes back to the gas wallet.
// - the gas wallet's own share: its top-up transaction (513,003) and taking
//   in the two excesses (103,736);
export const JETTON_GAS_WALLET_COST = 616_739n;
// - the deposit's transaction with two jetton transfers, both jetton hops and
//   the excesses sent back, to receivers whose jetton wallets exist;
export const JETTON_TRANSFERS_COST = 1_797_748n;
// - more when the deposit deploys itself in that transaction;
export const JETTON_DEPOSIT_DEPLOY_COST = 430_599n;
// - more per receiver whose jetton wallet the transfer deploys.
export const JETTON_NEW_WALLET_COST = 974_433n;
// The destination gets a transfer notification; services that credit
// incoming jettons only on that notification would miss a transfer without it.
const DESTINATION_FORWARD_TON = 1n;

const OP_TRANSFER = 0x0f8a7ea5;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_EXCESSES = 0xd53276db;

// A full page is treated as a listing that may be missing some.
const PAYMENT_LIST_LIMIT = 100;
// The gas wallet tops up every jetton payout, so its history is long.
const GAS_WALLET_TX_LIMIT = 100;
// The deposit also receives every payer's transfer notification.
const DEPOSIT_TX_LIMIT = 100;

const TON_ASSET: AssetId = "ton";
const TON_DECIMALS = 9;
const PRICE_DECIMALS = 10;

export type TonJetton = { asset: AssetId; master: string; decimals: number };

export type TonJettonDeps = {
  api: TonApi;
  jetton: TonJetton;
  /** Our own config: a bad one makes the payout wait with a review note. */
  platformAddress: string;
  gasWalletKey: SealedSecret | undefined;
  getPrice: PricePort;
};

const text = (address: Address) => address.toString({ bounceable: false });

// ---------- Get methods (toncenter v2 runGetMethod) ----------

async function runGetMethod(api: TonApi, address: Address, method: string, stack: unknown[]) {
  const parsed = z
    .object({ exit_code: z.number(), stack: z.array(z.array(z.unknown())) })
    .safeParse(await api("runGetMethod", { body: { address: address.toString(), method, stack } }));
  if (!parsed.success || parsed.data.exit_code !== 0) return undefined;
  return parsed.data.stack;
}

function stackCell(item: unknown[] | undefined): Cell | undefined {
  if (item?.[0] !== "cell" && item?.[0] !== "slice") return undefined;
  const bytes = z.object({ bytes: z.string() }).safeParse(item[1]);
  if (!bytes.success) return undefined;
  try {
    return Cell.fromBase64(bytes.data.bytes);
  } catch {
    return undefined;
  }
}

function stackNumber(item: unknown[] | undefined): bigint | undefined {
  if (item?.[0] !== "num" || typeof item[1] !== "string") return undefined;
  try {
    const value = item[1];
    return value.startsWith("-") ? -BigInt(value.slice(1)) : BigInt(value);
  } catch {
    return undefined;
  }
}

// An owner's jetton wallet address never changes, so it is asked once.
const jettonWalletCache = new Map<string, Address>();
const JETTON_WALLET_CACHE_LIMIT = 10_000;

/** The jetton wallet `master` gives `owner`. undefined: the lookup failed. */
export async function jettonWalletOf(api: TonApi, master: Address, owner: Address): Promise<Address | undefined> {
  const key = `${master.toRawString()}|${owner.toRawString()}`;
  const cached = jettonWalletCache.get(key);
  if (cached) return cached;

  const ownerSlice = beginCell().storeAddress(owner).endCell().toBoc().toString("base64");
  const stack = await runGetMethod(api, master, "get_wallet_address", [["tvm.Slice", ownerSlice]]);
  const cell = stackCell(stack?.[0] as unknown[] | undefined);
  if (cell === undefined) return undefined;
  let wallet: Address | null;
  try {
    wallet = cell.beginParse().loadMaybeAddress();
  } catch {
    return undefined;
  }
  if (wallet === null || wallet.workChain !== 0) return undefined;

  if (jettonWalletCache.size >= JETTON_WALLET_CACHE_LIMIT) jettonWalletCache.clear();
  jettonWalletCache.set(key, wallet);
  return wallet;
}

/** Tokens in a jetton wallet: 0 if it was never deployed. undefined: the lookup failed. */
async function jettonBalance(api: TonApi, jettonWallet: Address): Promise<bigint | undefined> {
  const account = await getTonAccount(api, jettonWallet);
  if (account === undefined || account.state === "frozen") return undefined;
  if (account.state === "uninitialized") return 0n;
  const stack = await runGetMethod(api, jettonWallet, "get_wallet_data", []);
  const balance = stackNumber(stack?.[0] as unknown[] | undefined);
  return balance !== undefined && balance >= 0n ? balance : undefined;
}

// ---------- Reading transactions ----------

function readTx(data: string) {
  let root: Cell;
  let tx: ReturnType<typeof loadTransaction>;
  try {
    root = Cell.fromBase64(data);
    tx = loadTransaction(root.beginParse());
  } catch {
    return undefined;
  }
  const d = tx.description;
  // Executed and committed: the code ran, and its state and messages stand.
  const ok =
    d.type === "generic" &&
    !d.aborted &&
    d.computePhase.type === "vm" &&
    d.computePhase.success &&
    (d.actionPhase?.success ?? true);
  const exitCode = d.type === "generic" && d.computePhase.type === "vm" ? d.computePhase.exitCode : undefined;
  return { tx, hash: root.hash().toString("hex"), ok, exitCode };
}

/** A jetton message body (transfer or internal_transfer): its query id and amount. */
function readJettonBody(body: Cell, op: number): { queryId: bigint; amount: bigint } | undefined {
  try {
    const slice = body.beginParse();
    if (slice.remainingBits < 96 || slice.loadUint(32) !== op) return undefined;
    return { queryId: slice.loadUintBig(64), amount: slice.loadCoins() };
  } catch {
    return undefined;
  }
}

async function locateResultTx(api: TonApi, source: Address, destination: Address, createdLt: bigint) {
  const parsed = z.object({ data: z.string().min(1) }).safeParse(
    await api("tryLocateResultTx", {
      query: { source: source.toString(), destination: destination.toString(), created_lt: createdLt.toString() },
    }),
  );
  if (!parsed.success) return undefined;
  const read = readTx(parsed.data.data);
  // Only the transaction that this very message started.
  const inMessage = read?.tx.inMessage?.info;
  if (inMessage?.type !== "internal" || !inMessage.src.equals(source) || inMessage.createdLt !== createdLt) {
    return undefined;
  }
  return read;
}

// ---------- Payment lookup ----------

// One payment = one transaction in which the deposit's jetton wallet ran an
// incoming internal_transfer and kept it. Only the real master's jetton
// wallets and the master itself can make it accept one (its code checks
// the sender), and the wallet's address commits to that code. A fake
// jetton's transfers credit a different jetton wallet and are never read.
function readJettonCredit(data: string): ChainPayment | null | undefined {
  const read = readTx(data);
  if (read === undefined) return undefined;
  const inMessage = read.tx.inMessage;
  if (inMessage?.info.type !== "internal" || inMessage.info.bounced || !read.ok) return null;
  const body = readJettonBody(inMessage.body, OP_INTERNAL_TRANSFER);
  if (body === undefined || body.amount <= 0n) return null;
  return {
    txid: read.hash,
    amount: body.amount,
    // TON has no reorgs: a transaction the API shows is final.
    confirmations: 1,
    seenAt: read.tx.now * 1000,
  };
}

/** For the invoice watcher: every jetton payment to a deposit. undefined = failed or possibly incomplete. */
export async function getTonJettonPayments(
  api: TonApi,
  jetton: TonJetton,
  depositAddress: string,
): Promise<ChainPayment[] | undefined> {
  const owner = parseTonAddress(depositAddress);
  const master = parseTonAddress(jetton.master);
  if (owner === undefined || master === undefined) return undefined;
  const wallet = await jettonWalletOf(api, master, owner);
  if (wallet === undefined) return undefined;

  const transactions = await getRecentTonTransactions(api, wallet, PAYMENT_LIST_LIMIT);
  if (transactions === undefined) return undefined;
  if (transactions.length >= PAYMENT_LIST_LIMIT) {
    console.warn("TON jetton payment listing may be incomplete:", depositAddress);
    return undefined;
  }

  const payments: ChainPayment[] = [];
  for (const data of transactions) {
    const payment = readJettonCredit(data);
    if (payment === undefined) return undefined;
    if (payment !== null) payments.push(payment);
  }

  // Only payouts lower a jetton balance, so more than everything listed as
  // received means the listing is missing a payment.
  const balance = await jettonBalance(api, wallet);
  if (balance === undefined) return undefined;
  const listed = payments.reduce((sum, p) => sum + p.amount, 0n);
  if (balance > listed) {
    console.warn("TON jetton deposit holds more than its listed payments:", depositAddress);
    return undefined;
  }
  return payments;
}

// ---------- Network cost ----------

/** `nanoton` in jetton units at the current USD prices, rounded up (the platform's favour). */
async function tonInTokenUnits(nanoton: bigint, jetton: TonJetton, getPrice: PricePort): Promise<bigint | undefined> {
  if (nanoton === 0n) return 0n;
  const [tonText, tokenText] = await Promise.all([getPrice(TON_ASSET, "usd"), getPrice(jetton.asset, "usd")]);
  const tonPrice = tonText === undefined ? undefined : decimalStrToBigInt(tonText, PRICE_DECIMALS);
  const tokenPrice = tokenText === undefined ? undefined : decimalStrToBigInt(tokenText, PRICE_DECIMALS);
  if (tonPrice === undefined || tokenPrice === undefined || tonPrice <= 0n || tokenPrice <= 0n) return undefined;
  return ceilDivide(nanoton * tonPrice * 10n ** BigInt(jetton.decimals), tokenPrice * 10n ** BigInt(TON_DECIMALS));
}

const depositNeeds = (transferCount: number) =>
  BigInt(transferCount) * JETTON_TRANSFER_TON + JETTON_DEPOSIT_FEE_BUDGET;
const gasWalletSpend = (topUp: bigint) => (topUp === 0n ? 0n : topUp + GAS_WALLET_FEE_BUDGET);

/**
 * Nanoton the merchant is charged for a payout that tops up (fix ticket F):
 * the measured cost, less the TON already at the deposit, which the last
 * transfer sends back with the rest. The gas wallet's own share is always
 * charged.
 */
export function jettonPayoutCharge(input: { depositDeployed: boolean; newJettonWallets: number; depositTon: bigint }): bigint {
  const atDeposit =
    JETTON_TRANSFERS_COST + (input.depositDeployed ? 0n : JETTON_DEPOSIT_DEPLOY_COST) + BigInt(input.newJettonWallets) * JETTON_NEW_WALLET_COST;
  return (atDeposit > input.depositTon ? atDeposit - input.depositTon : 0n) + JETTON_GAS_WALLET_COST;
}

/**
 * Payer-pays estimate, in jetton units: a new deposit holding no TON, two
 * transfers to receivers that already hold the jetton, at today's prices.
 */
export async function estimateTonJettonNetworkCost(deps: { jetton: TonJetton; getPrice: PricePort }) {
  const charged = jettonPayoutCharge({ depositDeployed: false, newJettonWallets: 0, depositTon: 0n });
  return await tonInTokenUnits(charged, deps.jetton, deps.getPrice);
}

// ---------- Saved state ----------

const u64String = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const signedSchema = z.object({
  boc: z.string().min(1),
  seqno: z.number().int().nonnegative(),
  validUntil: z.number().int().positive(),
});
const stateSchema = z.object({
  v: z.literal(1),
  mode: z.literal("jetton"),
  phase: z.enum(["top_up", "transfers"]),
  /** Nanoton the gas wallet plans to spend: the top-up plus its fee budget (what the merchant was charged before fix ticket F). */
  plannedGasSpend: u64String,
  /** The deposit's seqno when the payout was planned: its transfers must use it. */
  depositSeqno: z.number().int().nonnegative(),
  topUp: z
    .object({
      gasWallet: z.string().regex(/^0:[0-9a-f]{64}$/),
      value: u64String,
      signed: signedSchema,
      /** Once it landed: the gas wallet's transaction and what it really spent. */
      txHash: z.string().optional(),
      spent: u64String.optional(),
    })
    .optional(),
  /** Phase transfers: the deposit's signed message. */
  deposit: signedSchema.optional(),
  /**
   * The gas wallet (raw form) the jetton transfers send unused TON to, the
   * last transfer carrying all the deposit's TON (fix ticket F). Absent: the
   * deposit is the response destination and keeps it (no top-up, or a payout
   * saved before fix ticket F).
   */
  sweepTo: z.string().regex(/^0:[0-9a-f]{64}$/).optional(),
  /** Nanoton the merchant is charged for (fix ticket F); absent in payouts saved before it. */
  charged: u64String.optional(),
  /** Destination first, then the platform (if it gets anything). */
  transfers: z
    .array(
      z.object({
        kind: z.enum(["merchant_payout", "refund_route", "swap_deposit", "platform_fee"]),
        owner: z.string(),
        amount: u64String,
        forward: u64String,
      }),
    )
    .min(1),
});
type JettonState = z.infer<typeof stateSchema>;
type Signed = z.infer<typeof signedSchema>;

function readState(raw: string): JettonState | undefined {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const hashOf = (boc: string) => Cell.fromBase64(boc).hash().toString("hex");
// Unique per deposit: each signed message has its own seqno.
const queryIdOf = (seqno: number, index: number) => BigInt(seqno) * 16n + BigInt(index);

function checkpointOf(state: JettonState, depositAddress: string, platformFee: bigint, reimbursement: bigint): PayoutCheckpoint {
  const transfers: Transfer[] = [];
  if (state.topUp) {
    transfers.push({
      kind: "gas_top_up",
      to: depositAddress,
      // In nanoton. The others are in jetton units.
      amount: BigInt(state.topUp.spent ?? state.plannedGasSpend),
      txid: state.topUp.txHash ?? hashOf(state.topUp.signed.boc),
    });
  }
  const depositTxid = state.deposit ? hashOf(state.deposit.boc) : "";
  for (const t of state.transfers) {
    transfers.push({ kind: t.kind, to: t.owner, amount: BigInt(t.amount), txid: depositTxid });
  }
  // networkCost in jetton units: the gas wallet's planned spend, converted.
  return { state: JSON.stringify(state), plan: { transfers, platformFee, networkCost: reimbursement } };
}

// ---------- Signing ----------

function signTopUp(gasWallet: TonWallet, seqno: number, deploy: boolean, validUntil: number, deposit: Address, value: bigint): Signed {
  const signed = signW5External({
    wallet: gasWallet,
    seqno,
    deploy,
    validUntil,
    messages: [
      {
        mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        message: internal({ to: deposit, value, bounce: false }),
      },
    ],
  });
  return { boc: signed.boc, seqno, validUntil };
}

function signTransfers(input: {
  wallet: TonWallet;
  seqno: number;
  deploy: boolean;
  validUntil: number;
  depositJettonWallet: Address;
  transfers: JettonState["transfers"];
  sweepTo: string | undefined;
}): Signed {
  const response = input.sweepTo === undefined ? input.wallet.contract.address : Address.parseRaw(input.sweepTo);
  const last = input.transfers.length - 1;
  const signed = signW5External({
    wallet: input.wallet,
    seqno: input.seqno,
    deploy: input.deploy,
    validUntil: input.validUntil,
    messages: input.transfers.map((t, index) => ({
      mode:
        input.sweepTo !== undefined && index === last
          ? SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.IGNORE_ERRORS
          : SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      message: internal({
        to: input.depositJettonWallet,
        value: JETTON_TRANSFER_TON,
        bounce: true,
        body: beginCell()
          .storeUint(OP_TRANSFER, 32)
          .storeUint(queryIdOf(input.seqno, index), 64)
          .storeCoins(BigInt(t.amount))
          .storeAddress(Address.parse(t.owner))
          .storeAddress(response)
          .storeMaybeRef(null)
          .storeCoins(BigInt(t.forward))
          .storeBit(false)
          .endCell(),
      }),
    })),
  });
  return { boc: signed.boc, seqno: input.seqno, validUntil: input.validUntil };
}

// ---------- The payout ----------

type Context = {
  request: PayoutRequest;
  deps: TonJettonDeps;
  deposit: Address;
  depositWallet: TonWallet;
  master: Address;
  what: string;
  /** The saved payout's sweep destination, once known (see JettonState.sweepTo). */
  sweepTo?: Address;
};

const pending = (reason: string, review?: string): PayoutResult => ({ status: "pending", reason, ...(review ? { review } : {}) });

function stillAt(ctx: Pick<Context, "request" | "what">) {
  return `The ${ctx.what} are still at deposit address ${ctx.request.depositAddress}.`;
}

function stopped(ctx: Pick<Context, "request" | "what">, reason: string, transfers: Transfer[] = []): PayoutResult {
  return {
    status: "failed",
    message: `TON jetton payout stopped: ${reason}. ${stillAt(ctx)} Nothing more was sent. Fix the cause, then pay out by hand with the deposit key.`,
    transfers,
  };
}

/** The TON jetton side of ChainAdapter.payout (src/chains/adapter.ts). Never touches the database. */
export async function payOutTonJetton(request: PayoutRequest, deps: TonJettonDeps): Promise<PayoutResult> {
  const what = `${deps.jetton.asset} tokens`;
  const base = { request, what };
  if (request.receiveAsset !== deps.jetton.asset) {
    return stopped(base, `a ${deps.jetton.asset} deposit pays out only as ${deps.jetton.asset}, not ${request.receiveAsset}`);
  }
  if (request.depositKey.kind !== "sealed_key") {
    return stopped(base, "this deposit has no key of its own");
  }
  const deposit = parseTonAddress(request.depositAddress);
  const master = parseTonAddress(deps.jetton.master);
  if (deposit === undefined || master === undefined) {
    return stopped(base, `deposit address "${request.depositAddress}" or the jetton master is not a valid TON address`);
  }

  let depositWallet: TonWallet;
  try {
    depositWallet = await loadTonWallet(openSecret("ton-deposit-key", request.depositKey.sealed));
  } catch (error) {
    return stopped(base, `the deposit key could not be opened (${error instanceof Error ? error.message : "unknown error"})`);
  }
  try {
    if (!depositWallet.contract.address.equals(deposit)) {
      return stopped(base, `the saved key does not control deposit address ${request.depositAddress}`);
    }
    const ctx: Context = { request, deps, deposit, depositWallet, master, what };
    if (request.checkpoint === undefined) return await start(ctx);
    const state = readState(request.checkpoint.state);
    if (state === undefined) {
      return pending(
        "no readable saved TON jetton payout",
        `Invoice is processing but has no readable saved TON jetton payout (a bug or a manual DB edit). ${stillAt(ctx)} Check an explorer before sending anything.`,
      );
    }
    const { platformFee, networkCost } = request.checkpoint.plan;
    return await follow(ctx, state, platformFee, networkCost);
  } finally {
    depositWallet.secretKey.fill(0);
  }
}

type GasWallet = { wallet: TonWallet } | { result: PayoutResult };

async function openGasWallet(ctx: Context): Promise<GasWallet> {
  if (ctx.deps.gasWalletKey === undefined) {
    return {
      result: pending(
        "TON gas wallet is not configured",
        `The TON gas wallet key is not configured, so this jetton payout can't pay its TON fees and waits. Nothing was sent. ${stillAt(ctx)} Set TON_GAS_WALLET_KEY in the server config.`,
      ),
    };
  }
  try {
    return { wallet: await loadTonWallet(openSecret("ton-gas-wallet-key", ctx.deps.gasWalletKey)) };
  } catch {
    return {
      result: pending(
        "TON gas wallet key can't be opened",
        `The TON gas wallet key can't be opened with the current data key, so this jetton payout waits. Nothing was sent. ${stillAt(ctx)}`,
      ),
    };
  }
}

async function start(ctx: Context): Promise<PayoutResult> {
  const { request, deps, deposit } = ctx;
  const { api, jetton } = deps;

  const gas = await openGasWallet(ctx);
  if ("result" in gas) return gas.result;
  try {
    const platform = parseTonAddress(deps.platformAddress);
    if (platform === undefined) {
      return pending("platform TON address is invalid", `PLATFORM_TON_ADDRESS is not a valid mainnet TON address. Nothing was sent. ${stillAt(ctx)}`);
    }
    const destination = parseTonAddress(request.destination);
    if (destination === undefined) {
      return stopped(ctx, `destination "${request.destination}" is not a valid mainnet TON address`);
    }
    if (sameTonAccount(request.destination, request.depositAddress)) {
      return stopped(ctx, "the destination is the deposit address itself");
    }

    const [platformInfo, destinationInfo, account] = await Promise.all([
      getTonDestination(api, platform),
      getTonDestination(api, destination),
      getTonAccount(api, deposit),
    ]);
    if (platformInfo === undefined || destinationInfo === undefined || account === undefined) {
      return pending("TON account lookup failed");
    }
    if (platformInfo.state === "frozen" || (platformInfo.state === "active" && !platformInfo.isWallet)) {
      return pending(
        "the platform TON address can't receive",
        `PLATFORM_TON_ADDRESS ${deps.platformAddress} is frozen or not a normal TON wallet. Nothing was sent. ${stillAt(ctx)} Fix PLATFORM_TON_ADDRESS.`,
      );
    }
    if (destinationInfo.state === "frozen") {
      return stopped(ctx, `${request.destination} is frozen, so it can't receive. Ask the merchant for another wallet address`);
    }
    if (destinationInfo.state === "active" && !destinationInfo.isWallet) {
      return stopped(ctx, `${notAWallet(request.destination)}. Ask the merchant for a normal wallet address`);
    }

    const walletState = readDepositWallet(account, ctx.depositWallet.contract);
    if ("problem" in walletState) return stopped(ctx, walletState.problem);

    const depositJettonWallet = await jettonWalletOf(api, ctx.master, deposit);
    if (depositJettonWallet === undefined) return pending("jetton wallet lookup failed");
    const received = await jettonBalance(api, depositJettonWallet);
    if (received === undefined) return pending("deposit jetton balance unavailable");
    if (received === 0n || received < request.minimumAmount) {
      return pending("the deposit holds less than the payout minimum");
    }

    // Receivers whose jetton wallet this payout deploys cost more.
    let newJettonWallets = 0;
    for (const owner of [destination, platform]) {
      const wallet = await jettonWalletOf(api, ctx.master, owner);
      const walletAccount = wallet === undefined ? undefined : await getTonAccount(api, wallet);
      if (walletAccount === undefined) return pending("jetton wallet lookup failed");
      if (walletAccount.state !== "active") newJettonWallets += 1;
    }

    // TON already at the deposit (a payer's, or left by an earlier payout) counts.
    const plan = async (transferCount: number) => {
      const needed = depositNeeds(transferCount);
      const topUp = needed > account.balance ? needed - account.balance : 0n;
      const gasSpend = gasWalletSpend(topUp);
      const charged =
        topUp === 0n ? 0n : jettonPayoutCharge({ depositDeployed: walletState.deployed, newJettonWallets, depositTon: account.balance });
      const reimbursement = await tonInTokenUnits(charged, jetton, deps.getPrice);
      if (reimbursement === undefined) return undefined;
      return { topUp, gasSpend, charged, reimbursement, split: splitPayout({ received, networkCost: reimbursement, feeRate: request.feeRate, feeExempt: request.feeExempt ?? 0n }) };
    };
    let planned = await plan(2);
    if (planned === undefined) return pending(`no TON/${jetton.asset} price to convert the network cost`);
    if (planned.split === undefined) {
      return { status: "too_small", reason: `${jetton.asset} payout is too small after the fee and the TON network cost` };
    }
    if (planned.split.platformFee + planned.reimbursement === 0n) {
      // Nothing for the platform: one transfer, so less TON is needed.
      planned = await plan(1);
      if (planned === undefined) return pending(`no TON/${jetton.asset} price to convert the network cost`);
      if (planned.split === undefined) {
        return { status: "too_small", reason: `${jetton.asset} payout is too small after the fee and the TON network cost` };
      }
    }
    const { topUp, gasSpend, charged, reimbursement } = planned;
    const split = planned.split!;
    const platformAmount = split.platformFee + reimbursement;

    const transfers: JettonState["transfers"] = [
      {
        kind: request.destinationKind,
        owner: text(destination),
        amount: split.merchantAmount.toString(),
        forward: DESTINATION_FORWARD_TON.toString(),
      },
    ];
    if (platformAmount > 0n) {
      transfers.push({ kind: "platform_fee", owner: text(platform), amount: platformAmount.toString(), forward: "0" });
    }
    const base: JettonState = {
      v: 1,
      mode: "jetton",
      phase: "transfers",
      plannedGasSpend: gasSpend.toString(),
      charged: charged.toString(),
      depositSeqno: walletState.seqno,
      transfers,
    };

    if (topUp === 0n) {
      return await sendTransfers(ctx, base, split.platformFee, reimbursement);
    }

    const gasAddress = gas.wallet.contract.address;
    const gasAccount = await getTonAccount(api, gasAddress);
    if (gasAccount === undefined) return pending("TON gas wallet lookup failed");
    const gasState = readDepositWallet(gasAccount, gas.wallet.contract);
    if ("problem" in gasState) {
      return pending("the TON gas wallet can't send", `TON gas wallet ${text(gasAddress)}: ${gasState.problem}. Nothing was sent. ${stillAt(ctx)}`);
    }
    if (gasAccount.balance < gasSpend) {
      return pending(
        "TON gas wallet is short of funds",
        `The TON gas wallet ${text(gasAddress)} holds ${gasAccount.balance} nanoton and this jetton payout's top-up needs ${gasSpend}. Fund the gas wallet; the payout continues by itself. ${stillAt(ctx)}`,
      );
    }
    const signed = signTopUp(gas.wallet, gasState.seqno, !gasState.deployed, gasAccount.chainTime + TX_LIFETIME_SECONDS, deposit, topUp);
    const state: JettonState = {
      ...base,
      phase: "top_up",
      topUp: { gasWallet: gasAddress.toRawString(), value: topUp.toString(), signed },
      sweepTo: gasAddress.toRawString(),
    };
    if (!(await request.saveCheckpoint(checkpointOf(state, request.depositAddress, split.platformFee, reimbursement)))) {
      return pending("another run saved this payout first");
    }
    await sendTonMessage(api, signed.boc);
    return pending("gas top-up sent; waiting for it to land");
  } finally {
    gas.wallet.secretKey.fill(0);
  }
}

/** Signs the deposit's transfers (its TON is there), saves, then sends. */
async function sendTransfers(ctx: Context, state: JettonState, platformFee: bigint, reimbursement: bigint): Promise<PayoutResult> {
  const { api } = ctx.deps;
  const account = await getTonAccount(api, ctx.deposit);
  if (account === undefined) return pending("deposit account lookup failed");
  const walletState = readDepositWallet(account, ctx.depositWallet.contract);
  if ("problem" in walletState) return stopped(ctx, walletState.problem, topUpMoved(ctx, state));
  if (walletState.seqno !== state.depositSeqno) {
    return pending(
      "the deposit wallet sent something since this payout was planned",
      `Deposit wallet ${ctx.request.depositAddress} is at seqno ${walletState.seqno}, but this payout was planned at ${state.depositSeqno}: it sent something in between. Check its jetton wallet on an explorer before retrying; nothing was sent now.`,
    );
  }
  const depositJettonWallet = await jettonWalletOf(api, ctx.master, ctx.deposit);
  if (depositJettonWallet === undefined) return pending("jetton wallet lookup failed");

  const signed = signTransfers({
    wallet: ctx.depositWallet,
    seqno: walletState.seqno,
    deploy: !walletState.deployed,
    validUntil: account.chainTime + TX_LIFETIME_SECONDS,
    depositJettonWallet,
    transfers: state.transfers,
    sweepTo: state.sweepTo,
  });
  const next: JettonState = { ...state, phase: "transfers", deposit: signed };
  if (!(await ctx.request.saveCheckpoint(checkpointOf(next, ctx.request.depositAddress, platformFee, reimbursement)))) {
    return pending("another run saved this payout first");
  }
  await sendTonMessage(api, signed.boc);
  return pending("jetton transfers sent; waiting for them to land");
}

async function follow(ctx: Context, state: JettonState, platformFee: bigint, reimbursement: bigint): Promise<PayoutResult> {
  if (state.phase === "top_up") return await followTopUp(ctx, state, platformFee, reimbursement);
  if (state.deposit === undefined) {
    return pending("saved TON jetton payout has no signed transfers", `The saved TON jetton payout is in its transfer phase without a signed message (a bug). ${stillAt(ctx)}`);
  }
  return await followTransfers(ctx, state, state.deposit, platformFee, reimbursement);
}

async function followTopUp(ctx: Context, state: JettonState, platformFee: bigint, reimbursement: bigint): Promise<PayoutResult> {
  const { api } = ctx.deps;
  const topUp = state.topUp;
  if (topUp === undefined) {
    return pending("saved TON jetton top-up is missing", `The saved TON jetton payout is in its top-up phase without a top-up (a bug). ${stillAt(ctx)}`);
  }
  const gasAddress = Address.parseRaw(topUp.gasWallet);
  const value = BigInt(topUp.value);
  const gasAccount = await getTonAccount(api, gasAddress);
  if (gasAccount === undefined) return pending("TON gas wallet lookup failed");
  const seqno = readSeqno(gasAccount);
  if (seqno === undefined) return pending("TON gas wallet seqno unreadable");

  if (seqno > topUp.signed.seqno) {
    const transactions = await getRecentTonTransactions(api, gasAddress, GAS_WALLET_TX_LIMIT);
    if (transactions === undefined) return pending("TON gas wallet transactions lookup failed");
    const landed = findPayoutBySeqno(transactions, topUp.signed.seqno);
    if (landed === undefined) {
      return pending(
        "gas wallet seqno used, but its transaction is not in the recent list",
        `TON gas wallet ${text(gasAddress)} used seqno ${topUp.signed.seqno}, but that transaction is not among its latest ${GAS_WALLET_TX_LIMIT}. Check on an explorer whether it topped up deposit address ${ctx.request.depositAddress} before retrying. ${stillAt(ctx)}`,
      );
    }
    if (paidExactly(landed.sent, ctx.deposit, value)) {
      // Non-bounceable to our own deposit, so it is credited (ADR 0001);
      // the transfers wait until it has been. A deployed deposit pays a
      // little of it to receive it, so its balance is no proof.
      const message = landed.outgoing.find((m) => m.to.equals(ctx.deposit) && m.value === value && !m.bounce)!;
      const credit = await locateResultTx(api, gasAddress, ctx.deposit, message.createdLt);
      if (credit === undefined) return pending("waiting for the gas top-up to reach the deposit");
      const next: JettonState = { ...state, topUp: { ...topUp, txHash: landed.txHash, spent: landed.spent.toString() } };
      return await sendTransfers(ctx, next, platformFee, reimbursement);
    }
    // That seqno went to another transaction (or ours sent nothing): this
    // top-up can never land. Same value, the next free seqno, saved first.
    return await rebuildTopUp(ctx, state, platformFee, reimbursement);
  }

  if (seqno < topUp.signed.seqno) {
    return pending(
      "TON gas wallet seqno went down",
      `TON gas wallet seqno is ${seqno}, below the saved top-up's ${topUp.signed.seqno}. Check gas wallet ${text(gasAddress)} on an explorer. ${stillAt(ctx)}`,
    );
  }
  if (gasAccount.chainTime <= topUp.signed.validUntil + EXPIRY_MARGIN_SECONDS) {
    await sendTonMessage(api, topUp.signed.boc);
    return pending("gas top-up not landed yet; sent again");
  }
  // Expired with its seqno unused: a new one with that seqno is safe.
  return await rebuildTopUp(ctx, state, platformFee, reimbursement);
}

async function rebuildTopUp(ctx: Context, state: JettonState, platformFee: bigint, reimbursement: bigint): Promise<PayoutResult> {
  const { api } = ctx.deps;
  const topUp = state.topUp!;
  const gas = await openGasWallet(ctx);
  if ("result" in gas) return gas.result;
  try {
    if (gas.wallet.contract.address.toRawString() !== topUp.gasWallet) {
      return pending(
        "the TON gas wallet changed",
        `The gas top-up for deposit ${ctx.request.depositAddress} must be sent again, but the configured TON gas wallet is not the one that signed it. Review before retrying. ${stillAt(ctx)}`,
      );
    }
    const gasAccount = await getTonAccount(api, gas.wallet.contract.address);
    if (gasAccount === undefined) return pending("TON gas wallet lookup failed");
    const gasState = readDepositWallet(gasAccount, gas.wallet.contract);
    if ("problem" in gasState) return pending("the TON gas wallet can't send", `TON gas wallet: ${gasState.problem}. ${stillAt(ctx)}`);
    const value = BigInt(topUp.value);
    if (gasAccount.balance < gasWalletSpend(value)) {
      return pending(
        "TON gas wallet is short of funds",
        `The TON gas wallet holds ${gasAccount.balance} nanoton and this jetton payout's top-up needs ${gasWalletSpend(value)}. Fund the gas wallet; the payout continues by itself. ${stillAt(ctx)}`,
      );
    }
    const signed = signTopUp(gas.wallet, gasState.seqno, !gasState.deployed, gasAccount.chainTime + TX_LIFETIME_SECONDS, ctx.deposit, value);
    const next: JettonState = { ...state, topUp: { ...topUp, signed } };
    if (!(await ctx.request.saveCheckpoint(checkpointOf(next, ctx.request.depositAddress, platformFee, reimbursement)))) {
      return pending("another run saved this payout first");
    }
    await sendTonMessage(api, signed.boc);
    return pending("gas top-up could never land; rebuilt and sent");
  } finally {
    gas.wallet.secretKey.fill(0);
  }
}

function topUpMoved(ctx: Context, state: JettonState): Transfer[] {
  const topUp = state.topUp;
  if (topUp?.txHash === undefined || topUp.spent === undefined) return [];
  return [{ kind: "gas_top_up", to: ctx.request.depositAddress, amount: BigInt(topUp.spent), txid: topUp.txHash }];
}

async function followTransfers(
  ctx: Context,
  state: JettonState,
  saved: Signed,
  platformFee: bigint,
  reimbursement: bigint,
): Promise<PayoutResult> {
  const { api } = ctx.deps;
  const account = await getTonAccount(api, ctx.deposit);
  if (account === undefined) return pending("deposit account lookup failed");
  const seqno = readSeqno(account);
  if (seqno === undefined) return pending("deposit wallet seqno unreadable");

  if (seqno > saved.seqno) {
    const transactions = await getRecentTonTransactions(api, ctx.deposit, DEPOSIT_TX_LIMIT);
    if (transactions === undefined) return pending("deposit transactions lookup failed");
    const landed = findPayoutBySeqno(transactions, saved.seqno);
    if (landed === undefined) return pending("deposit seqno used, but its transaction is not in the recent list");
    return await prove(ctx, state, saved, landed);
  }
  if (seqno < saved.seqno) {
    return pending(
      "deposit wallet seqno went down",
      `TON deposit wallet seqno is ${seqno}, below the saved payout's ${saved.seqno}. Check deposit address ${ctx.request.depositAddress} on an explorer before sending anything.`,
    );
  }
  if (account.chainTime <= saved.validUntil + EXPIRY_MARGIN_SECONDS) {
    await sendTonMessage(api, saved.boc);
    return pending("jetton transfers not landed yet; sent again");
  }

  // Expired with its seqno unused: the same transfers, the same seqno.
  const walletState = readDepositWallet(account, ctx.depositWallet.contract);
  if ("problem" in walletState) return stopped(ctx, walletState.problem, topUpMoved(ctx, state));
  if (walletState.seqno !== saved.seqno) return pending("rebuild saw a different seqno");
  const depositJettonWallet = await jettonWalletOf(api, ctx.master, ctx.deposit);
  if (depositJettonWallet === undefined) return pending("jetton wallet lookup failed");
  const signed = signTransfers({
    wallet: ctx.depositWallet,
    seqno: saved.seqno,
    deploy: !walletState.deployed,
    validUntil: account.chainTime + TX_LIFETIME_SECONDS,
    depositJettonWallet,
    transfers: state.transfers,
    sweepTo: state.sweepTo,
  });
  const next: JettonState = { ...state, deposit: signed };
  if (!(await ctx.request.saveCheckpoint(checkpointOf(next, ctx.request.depositAddress, platformFee, reimbursement)))) {
    return pending("another run rebuilt it first");
  }
  await sendTonMessage(api, signed.boc);
  return pending("jetton transfers expired unsent; rebuilt and sent");
}

type Delivery =
  | { kind: "delivered"; amount: bigint; txid: string; excess?: { from: Address; value: bigint; createdLt: bigint } }
  | { kind: "in_flight" }
  | { kind: "problem"; problem: string };

/** Follows one transfer from the deposit to the receiver's jetton wallet. */
async function deliveryOf(
  ctx: Context,
  depositJettonWallet: Address,
  outgoing: OutgoingMessage[],
  queryId: bigint,
  planned: JettonState["transfers"][number],
): Promise<Delivery | undefined> {
  const { api } = ctx.deps;
  const amountText = `${planned.amount} ${ctx.deps.jetton.asset} units to ${planned.owner}`;
  const command = outgoing.find(
    (m) => m.to.equals(depositJettonWallet) && readJettonBody(m.body, OP_TRANSFER)?.queryId === queryId,
  );
  if (command === undefined) {
    return { kind: "problem", problem: `the deposit's payout transaction did not send the transfer of ${amountText} (not enough TON?): those tokens never left` };
  }

  const atDeposit = await locateResultTx(api, ctx.deposit, depositJettonWallet, command.createdLt);
  if (atDeposit === undefined) return { kind: "in_flight" };
  const internalTransfer = atDeposit.ok
    ? [...atDeposit.tx.outMessages.values()].find(
        (m) => m.info.type === "internal" && readJettonBody(m.body, OP_INTERNAL_TRANSFER)?.queryId === queryId,
      )
    : undefined;
  if (internalTransfer === undefined || internalTransfer.info.type !== "internal") {
    return {
      kind: "problem",
      problem: `the deposit's jetton wallet ${text(depositJettonWallet)} refused the transfer of ${amountText} (exit code ${atDeposit.exitCode ?? "none"}): those tokens never left, and the TON sent with it came back`,
    };
  }

  const owner = parseTonAddress(planned.owner);
  const receiverWallet = owner ? await jettonWalletOf(api, ctx.master, owner) : undefined;
  if (receiverWallet === undefined) return undefined;
  if (!internalTransfer.info.dest.equals(receiverWallet)) {
    return { kind: "problem", problem: `the transfer of ${amountText} went to ${text(internalTransfer.info.dest)}, not to that owner's jetton wallet ${text(receiverWallet)}` };
  }
  const atReceiver = await locateResultTx(api, depositJettonWallet, receiverWallet, internalTransfer.info.createdLt);
  if (atReceiver === undefined) return { kind: "in_flight" };
  const credited = atReceiver.tx.inMessage ? readJettonBody(atReceiver.tx.inMessage.body, OP_INTERNAL_TRANSFER) : undefined;
  if (!atReceiver.ok || credited === undefined) {
    return {
      kind: "problem",
      problem: `the receiver's jetton wallet ${text(receiverWallet)} refused ${amountText} (exit code ${atReceiver.exitCode ?? "none"}); the jetton bounces them back to the deposit's jetton wallet ${text(depositJettonWallet)}`,
    };
  }
  const sweepTo = ctx.sweepTo;
  const excess =
    sweepTo === undefined
      ? undefined
      : [...atReceiver.tx.outMessages.values()].find(
          (m) => m.info.type === "internal" && m.info.dest.equals(sweepTo) && readExcesses(m.body),
        );
  return {
    kind: "delivered",
    amount: credited.amount,
    txid: atReceiver.hash,
    ...(excess?.info.type === "internal" && { excess: { from: receiverWallet, value: excess.info.value.coins, createdLt: excess.info.createdLt } }),
  };
}

function readExcesses(body: Cell): boolean {
  try {
    const slice = body.beginParse();
    return slice.remainingBits >= 32 && slice.loadUint(32) === OP_EXCESSES;
  } catch {
    return false;
  }
}

async function prove(
  ctx: Context,
  state: JettonState,
  saved: Signed,
  landed: NonNullable<ReturnType<typeof findPayoutBySeqno>>,
): Promise<PayoutResult> {
  const moved = topUpMoved(ctx, state);
  if (landed.failed !== undefined) {
    return stopped(ctx, `the deposit's payout transaction ${landed.txHash} did not run (${landed.failed}), so no token moved`, moved);
  }
  const depositJettonWallet = await jettonWalletOf(ctx.deps.api, ctx.master, ctx.deposit);
  if (depositJettonWallet === undefined) return pending("jetton wallet lookup failed");
  const sweepCtx: Context = state.sweepTo === undefined ? ctx : { ...ctx, sweepTo: Address.parseRaw(state.sweepTo) };

  const deliveries: Delivery[] = [];
  for (const [index, planned] of state.transfers.entries()) {
    const delivery = await deliveryOf(sweepCtx, depositJettonWallet, landed.outgoing, queryIdOf(saved.seqno, index), planned);
    if (delivery === undefined) return pending("jetton wallet lookup failed");
    deliveries.push(delivery);
  }
  if (deliveries.some((d) => d.kind === "in_flight")) return pending("jetton transfers in flight");

  const notes: string[] = [];
  for (const [index, planned] of state.transfers.entries()) {
    const delivery = deliveries[index]!;
    if (delivery.kind === "delivered") {
      moved.push({ kind: planned.kind, to: planned.owner, amount: delivery.amount, txid: delivery.txid });
    }
  }
  const [destination, ...rest] = state.transfers;
  const first = deliveries[0]!;
  if (first.kind !== "delivered" || first.amount !== BigInt(destination!.amount)) {
    const why =
      first.kind === "problem"
        ? first.problem
        : first.kind === "delivered"
          ? `${destination!.owner} was credited ${first.amount}, not the planned ${destination!.amount}`
          : "the transfer did not arrive";
    return {
      status: "failed",
      message: `TON jetton payout tx ${landed.txHash} did not deliver to the destination: ${why}. Deposit address ${ctx.request.depositAddress}; check its jetton wallet on an explorer, then pay out by hand with the deposit key.`,
      transfers: moved,
    };
  }
  for (const [offset, planned] of rest.entries()) {
    const delivery = deliveries[offset + 1]!;
    if (delivery.kind !== "delivered" || delivery.amount !== BigInt(planned.amount)) {
      const why = delivery.kind === "problem" ? delivery.problem : `credited ${delivery.kind === "delivered" ? delivery.amount : 0}`;
      notes.push(`Platform share of ${planned.amount} was not delivered as planned: ${why}. Deposit address ${ctx.request.depositAddress}.`);
    }
  }
  // The unused TON each receiver's jetton wallet sent back to the gas wallet.
  for (const delivery of deliveries) {
    if (delivery.kind !== "delivered" || delivery.excess === undefined || sweepCtx.sweepTo === undefined) continue;
    const arrived = await locateResultTx(ctx.deps.api, delivery.excess.from, sweepCtx.sweepTo, delivery.excess.createdLt);
    if (arrived === undefined) return pending("the unused TON is on its way back to the gas wallet");
    moved.push({ kind: "gas_sweep", to: text(sweepCtx.sweepTo), amount: delivery.excess.value, txid: arrived.hash });
  }
  return { status: "paid", transfers: moved, ...(notes.length ? { note: notes.join(" ") } : {}) };
}
