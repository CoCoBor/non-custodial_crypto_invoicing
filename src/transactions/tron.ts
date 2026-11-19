import { AbiCoder, Wallet } from "ethers";
import { z } from "zod";

import type { AssetId } from "../assets/payout-address.js";
import type {
  AfterPayoutRequest,
  AfterPayoutResult,
  ChainPayment,
  PayoutCheckpoint,
  PayoutRequest,
  PayoutResult,
  Transfer,
} from "../chains/adapter.js";
import { evmFormOfTronAddress, isValidTronAddress, tronAddressFromEvm } from "../chains/tron-address.js";
import type { TronApi, TronTokenIndex } from "../chains/tron-api.js";
import { bandwidthBytes, signTronTx, type RefBlock, type SignedTronTx, type TronCall } from "../chains/tron-tx.js";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "../money/format.js";
import { splitPayout } from "../money/payout-split.js";
import { openSecret, type SealedSecret } from "../security/secret-envelope.js";

// USDT (TRC-20) on Tron. A deposit is a fresh secp256k1 key per invoice.
//
// A TRC-20 transfer costs energy and bandwidth. We neither stake nor rent
// them: the sender burns TRX for both (owner rule). A deposit holds no TRX,
// and receiving TRC-20 tokens does not even create its account. So a payout
// has two phases, each saved before it is sent:
// 1. top_up: the platform's TRX gas wallet sends the deposit the TRX its two
//    transfers will burn. That transfer also creates (activates) the
//    deposit's account; the gas wallet pays the activation fee.
// 2. transfers: the deposit sends USDT to the destination, then to the
//    platform (fee + reimbursement).
// What the gas wallet spends is converted to USDT at the current TRX price,
// rounded up, and rides on the platform's transfer, as on EVM.
// Since fix ticket F (owner option A) the merchant is charged the estimated
// burn only: the simulated energy at its price and the bandwidth the
// deposit's free allowance does not cover. The top-up still carries the
// energy headroom and every byte; once the transfers are solidified, what is
// left at the deposit goes back to the gas wallet (gas_sweep), saved first.
// Since fix ticket K (owner decision 2026-11-20) that sweep is the adapter's
// afterPayout: the payout is paid without waiting for it.
//
// Tron has no nonce. A signed transaction can land until its expiration;
// after that, once the solidified chain's head is past it, it never can.
// Only then is it rebuilt (saved before it is sent), so two versions can
// never both land.

export type TronToken = { asset: AssetId; contract: string; decimals: number };

export type TronPayoutDeps = {
  api: TronApi;
  token: TronToken;
  /** Our own config: a missing one makes the payout wait with a review note. */
  platformAddress: string | undefined;
  gasWalletKey: SealedSecret | undefined;
  /** TRX priced in the token (USDT), as decimal text; undefined when unavailable. */
  trxPrice: () => Promise<string | undefined>;
  /** How long a signed transaction stays valid. */
  txLifetimeMs?: number;
  /** How long past its expiration the solidified head must be before a saved transaction is called lost. */
  lostMarginMs?: number;
};

const TRX_DECIMALS = 6;
const PRICE_DECIMALS = 10;
// Over the simulated energy, for the fee limit and the TRX sent. Unused TRX
// stays at the deposit; the next payout from it tops up less.
const ENERGY_HEADROOM_PERCENT = 110n;
const DEFAULT_TX_LIFETIME_MS = 10 * 60_000;
// 20 blocks of 3 s: room for a provider's nodes at different heights.
const DEFAULT_LOST_MARGIN_MS = 60_000;
// A full list is treated as one that may be missing payments.
const MAX_LISTED_PAYMENTS = 100;
// A key nobody holds: signs throwaway copies to measure a transaction's size.
const SIZE_PROBE_KEY = "0x" + "11".repeat(32);

const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const abi = AbiCoder.defaultAbiCoder();

// ---------- Node reads ----------

const blockSchema = z.object({
  blockID: z.string().regex(/^[0-9a-f]{64}$/),
  block_header: z.object({ raw_data: z.object({ number: z.number().int().nonnegative(), timestamp: z.number().int().positive() }) }),
});

async function nowBlock(api: TronApi, solid = false): Promise<RefBlock | undefined> {
  const parsed = blockSchema.safeParse(await api.post(solid ? "/walletsolidity/getnowblock" : "/wallet/getnowblock", {}));
  if (!parsed.success) return undefined;
  const { number, timestamp } = parsed.data.block_header.raw_data;
  return { number: BigInt(number), blockId: parsed.data.blockID, timestamp };
}

type ChainFees = {
  /** Sun burned per energy unit. */
  energyFee: bigint;
  /** Sun burned per bandwidth byte. */
  bytesFee: bigint;
  /** Sun a TRX transfer to a new account costs its sender. */
  activationFee: bigint;
  /** Bandwidth bytes each account may use free per day. */
  freeNetLimit: bigint;
};

const parametersSchema = z.object({
  chainParameter: z.array(z.object({ key: z.string(), value: z.number().int().nonnegative().optional() })),
});

async function chainFees(api: TronApi): Promise<ChainFees | undefined> {
  const parsed = parametersSchema.safeParse(await api.post("/wallet/getchainparameters", {}));
  if (!parsed.success) return undefined;
  const params = new Map(parsed.data.chainParameter.map((p) => [p.key, BigInt(p.value ?? 0)]));
  const energyFee = params.get("getEnergyFee");
  const bytesFee = params.get("getTransactionFee");
  const createAccountFee = params.get("getCreateAccountFee");
  if (energyFee === undefined || energyFee === 0n || bytesFee === undefined || createAccountFee === undefined) return undefined;
  // Creating an account by a transfer burns getCreateAccountFee instead of
  // bandwidth, plus getCreateNewAccountFeeInSystemContract (1 TRX on mainnet;
  // the local node has none).
  const activationFee = createAccountFee + (params.get("getCreateNewAccountFeeInSystemContract") ?? 0n);
  return { energyFee, bytesFee, activationFee, freeNetLimit: params.get("getFreeNetLimit") ?? 0n };
}

/** Free bandwidth bytes `address` has left today; a new account gets the whole allowance. undefined: the lookup failed. */
async function freeBandwidth(api: TronApi, address: string, active: boolean, fees: ChainFees): Promise<bigint | undefined> {
  if (!active) return fees.freeNetLimit;
  const parsed = z
    .object({ freeNetLimit: z.number().int().nonnegative().optional(), freeNetUsed: z.number().int().nonnegative().optional() })
    .safeParse(await api.post("/wallet/getaccountnet", { address, visible: true }));
  if (!parsed.success) return undefined;
  const left = BigInt(parsed.data.freeNetLimit ?? 0) - BigInt(parsed.data.freeNetUsed ?? 0);
  return left > 0n ? left : 0n;
}

/**
 * Sun the bandwidth of transactions sent in this order burns. A transaction
 * uses the free allowance only if all its bytes fit, else it burns them all.
 */
function bandwidthBurn(sizes: bigint[], free: bigint, fees: ChainFees): bigint {
  let left = free;
  let burn = 0n;
  for (const size of sizes) {
    if (left >= size) left -= size;
    else burn += size * fees.bytesFee;
  }
  return burn;
}

type Account = { active: boolean; balance: bigint };

async function accountOf(api: TronApi, address: string): Promise<Account | undefined> {
  const reply = await api.post("/wallet/getaccount", { address, visible: true });
  const parsed = z.object({ address: z.string().optional(), balance: z.number().int().nonnegative().optional() }).safeParse(reply);
  if (!parsed.success) return undefined;
  // An address with no account (never received TRX) answers {}.
  return { active: parsed.data.address !== undefined, balance: BigInt(parsed.data.balance ?? 0) };
}

const constantSchema = z.object({
  result: z.object({ result: z.literal(true), message: z.string().optional() }),
  energy_used: z.number().int().nonnegative().optional(),
  constant_result: z.array(z.string()).optional(),
  transaction: z.object({ ret: z.array(z.object({ ret: z.string().optional() })).optional() }).optional(),
});

type ConstantCall = { reverted: true } | { reverted: false; energy: bigint; output: string };

async function constantCall(api: TronApi, owner: string, contract: string, selector: string, parameter: string): Promise<ConstantCall | undefined> {
  const parsed = constantSchema.safeParse(
    await api.post("/wallet/triggerconstantcontract", {
      owner_address: owner,
      contract_address: contract,
      function_selector: selector,
      parameter,
      visible: true,
    }),
  );
  if (!parsed.success) return undefined;
  // A revert still answers result: true, with a message and ret FAILED.
  if (parsed.data.result.message !== undefined || parsed.data.transaction?.ret?.some((r) => r.ret === "FAILED")) {
    return { reverted: true };
  }
  return { reverted: false, energy: BigInt(parsed.data.energy_used ?? 0), output: parsed.data.constant_result?.[0] ?? "" };
}

async function tokenBalance(api: TronApi, contract: string, owner: string): Promise<bigint | undefined> {
  const evmOwner = evmFormOfTronAddress(owner);
  if (evmOwner === undefined) return undefined;
  const call = await constantCall(api, owner, contract, "balanceOf(address)", abi.encode(["address"], [evmOwner]).slice(2));
  if (call === undefined || call.reverted || !/^[0-9a-f]{64}$/.test(call.output)) return undefined;
  return BigInt("0x" + call.output);
}

/** Energy a transfer of `amount` from `from` to `to` would use now (dynamic-energy penalty included). */
async function transferEnergy(api: TronApi, contract: string, from: string, to: string, amount: bigint): Promise<bigint | "reverted" | undefined> {
  const evmTo = evmFormOfTronAddress(to);
  if (evmTo === undefined) return undefined;
  const call = await constantCall(api, from, contract, "transfer(address,uint256)", abi.encode(["address", "uint256"], [evmTo, amount]).slice(2));
  if (call === undefined) return undefined;
  if (call.reverted) return "reverted";
  return call.energy > 0n ? call.energy : undefined;
}

const infoSchema = z.object({
  id: z.string(),
  fee: z.number().int().nonnegative().optional(),
  blockNumber: z.number().int().nonnegative(),
  blockTimeStamp: z.number().int().positive(),
  receipt: z.object({ result: z.string().optional() }).optional(),
  log: z
    .array(z.object({ address: z.string(), topics: z.array(z.string()).optional(), data: z.string().optional() }))
    .optional(),
});
type TxInfo = z.infer<typeof infoSchema>;

/** null: the node does not know it (yet). undefined: the lookup failed. */
async function txInfo(api: TronApi, txid: string, solid: boolean): Promise<TxInfo | null | undefined> {
  const reply = await api.post(solid ? "/walletsolidity/gettransactioninfobyid" : "/wallet/gettransactioninfobyid", { value: txid });
  if (reply !== null && typeof reply === "object" && Object.keys(reply).length === 0) return null;
  const parsed = infoSchema.safeParse(reply);
  if (!parsed.success || parsed.data.id !== txid) return undefined;
  return parsed.data;
}

type SavedTxFate =
  | { fate: "landed"; info: TxInfo }
  | { fate: "can_land" }
  | { fate: "wait"; reason: string }
  | { fate: "lost" };

/**
 * What became of a saved transaction. "lost" needs proof: the solidified
 * head, read first, is `lostMarginMs` past its expiration, and a lookup made
 * after that still finds it in no solidified block. A lookup made before the
 * head is no proof: the block holding it may be solidified in between, or
 * come from a provider's node behind the one that answered the head.
 */
async function savedTxFate(api: TronApi, signed: { txid: string; expiration: number }, lostMarginMs: number): Promise<SavedTxFate> {
  const wait = (reason: string): SavedTxFate => ({ fate: "wait", reason });
  const info = await txInfo(api, signed.txid, true);
  if (info === undefined) return wait("Tron transaction lookup failed");
  if (info !== null) return { fate: "landed", info };

  const solidHead = await nowBlock(api, true);
  if (solidHead === undefined) return wait("Tron solidified block unavailable");
  if (solidHead.timestamp <= signed.expiration) return { fate: "can_land" };
  if (solidHead.timestamp <= signed.expiration + lostMarginMs) {
    return wait(`Tron transaction ${signed.txid} expired; waiting ${lostMarginMs} ms past its expiration before rebuilding it`);
  }

  const again = await txInfo(api, signed.txid, true);
  if (again === undefined) return wait("Tron transaction lookup failed");
  if (again !== null) return { fate: "landed", info: again };
  return { fate: "lost" };
}

/** Token units `to` received from the token's own Transfer logs in one transaction (optionally only from `from`). */
function deliveredByLogs(info: TxInfo, contract: string, to: string, from?: string): bigint {
  const hex20 = (address: string) => evmFormOfTronAddress(address)!.slice(2).toLowerCase();
  const contractHex = hex20(contract);
  const toTopic = "0".repeat(24) + hex20(to);
  const fromTopic = from === undefined ? undefined : "0".repeat(24) + hex20(from);
  let total = 0n;
  for (const log of info.log ?? []) {
    const topics = (log.topics ?? []).map((t) => t.toLowerCase());
    if (log.address.toLowerCase().replace(/^41/, "") !== contractHex && log.address.toLowerCase() !== contractHex) continue;
    if (topics.length !== 3 || topics[0] !== TRANSFER_TOPIC || topics[2] !== toTopic) continue;
    if (fromTopic !== undefined && topics[1] !== fromTopic) continue;
    if (fromTopic === undefined && topics[1] === toTopic) continue;
    if (!/^[0-9a-fA-F]{64}$/.test(log.data ?? "")) continue;
    total += BigInt("0x" + log.data);
  }
  return total;
}

async function broadcast(api: TronApi, signed: SignedTronTx): Promise<void> {
  const reply = z.object({ result: z.boolean().optional(), code: z.string().optional() }).safeParse(
    await api.post("/wallet/broadcasthex", { transaction: signed.hex }),
  );
  if (reply.success && reply.data.result === true) console.log("TRX transaction broadcast:", signed.txid);
  else if (reply.success) console.warn("TRX broadcast refused:", signed.txid, reply.data.code ?? "");
  // A refusal (DUP_TRANSACTION_ERROR after it landed, ...) is decided by the next look at the chain.
}

// ---------- Payments ----------

/**
 * Each transaction that moved the token into `address`: the amount from the
 * token contract's own Transfer logs, read from the full node. The index
 * only names the transactions to look at.
 */
export async function getTronTokenPayments(
  deps: { api: TronApi; index: TronTokenIndex; token: TronToken },
  address: string,
): Promise<ChainPayment[] | undefined> {
  const { api, index, token } = deps;
  const listed = await index.transferTxids(address, token.contract);
  if (listed === undefined) return undefined;
  const txids = [...new Set(listed)];
  if (txids.length >= MAX_LISTED_PAYMENTS) return undefined;
  const head = await nowBlock(api);
  if (head === undefined) return undefined;

  const payments: ChainPayment[] = [];
  for (const txid of txids) {
    const info = await txInfo(api, txid, false);
    // Listed by the index but unknown to the node: the node lags, so the list may be incomplete.
    if (info === undefined || info === null) return undefined;
    if (info.receipt?.result !== "SUCCESS") continue;
    const amount = deliveredByLogs(info, token.contract, address);
    if (amount === 0n) continue;
    payments.push({
      txid,
      amount,
      confirmations: Number(head.number - BigInt(info.blockNumber) + 1n),
      seenAt: info.blockTimeStamp,
    });
  }

  // Outgoing transfers only lower the balance: a balance above everything
  // listed as received means a payment is missing from the list.
  const balance = await tokenBalance(api, token.contract, address);
  if (balance === undefined) return undefined;
  if (balance > payments.reduce((sum, p) => sum + p.amount, 0n)) return undefined;
  return payments;
}

// ---------- Planning ----------

async function trxInTokenUnits(sun: bigint, deps: Pick<TronPayoutDeps, "trxPrice" | "token">): Promise<bigint | undefined> {
  if (sun === 0n) return 0n;
  const text = await deps.trxPrice();
  const price = text === undefined ? undefined : decimalStrToBigInt(text, PRICE_DECIMALS);
  if (price === undefined || price <= 0n) return undefined;
  return ceilDivide(sun * price * 10n ** BigInt(deps.token.decimals), 10n ** BigInt(TRX_DECIMALS + PRICE_DECIMALS));
}

const feeLimitFor = (energy: bigint, fees: ChainFees) => ceilDivide(energy * fees.energyFee * ENERGY_HEADROOM_PERCENT, 100n);

/** Sun one deposit transfer may burn: its energy (with headroom) and all its bandwidth. */
function transferBurn(call: Extract<TronCall, { kind: "trc20_transfer" }>, fees: ChainFees, ref: RefBlock, lifetime: number): bigint {
  return call.feeLimit + transferSize(call, ref, lifetime) * fees.bytesFee;
}

/** Bandwidth bytes of a transaction, measured on a throwaway signed copy. */
function transferSize(call: TronCall, ref: RefBlock, lifetime: number): bigint {
  return bandwidthBytes(signTronTx(call, SIZE_PROBE_KEY, { ref, expiration: ref.timestamp + lifetime, now: ref.timestamp }));
}

/** Sun the gas wallet's own top-up transaction may burn. */
function topUpFee(depositActive: boolean, fees: ChainFees, transfer: { from: string; to: string; amount: bigint }, ref: RefBlock, lifetime: number): bigint {
  if (!depositActive) return fees.activationFee;
  // The amount's varint length changes the size.
  const probe = signTronTx({ kind: "trx", ...transfer }, SIZE_PROBE_KEY, { ref, expiration: ref.timestamp + lifetime, now: ref.timestamp });
  return bandwidthBytes(probe) * fees.bytesFee;
}

/**
 * Payer-pays estimate, in token units: the gas wallet's spend for a new
 * deposit (activation and two transfers), both receivers already holding
 * the token, at today's chain fees and TRX price.
 */
export async function estimateTronTokenNetworkCost(deps: Omit<TronPayoutDeps, "gasWalletKey">): Promise<bigint | undefined> {
  const { api, token, platformAddress } = deps;
  if (platformAddress === undefined || !isValidTronAddress(platformAddress)) return undefined;
  const lifetime = deps.txLifetimeMs ?? DEFAULT_TX_LIFETIME_MS;
  const [fees, head] = await Promise.all([chainFees(api), nowBlock(api)]);
  if (fees === undefined || head === undefined) return undefined;
  // A zero transfer needs no balance and writes the same storage as a
  // transfer to a receiver who already holds the token.
  const energy = await transferEnergy(api, token.contract, platformAddress, platformAddress, 0n);
  if (energy === undefined || energy === "reverted") return undefined;
  const call = { kind: "trc20_transfer", from: platformAddress, contract: token.contract, to: platformAddress, amount: 1n, feeLimit: feeLimitFor(energy, fees) } as const;
  const size = transferSize(call, head, lifetime);
  const charged = 2n * energy * fees.energyFee + bandwidthBurn([size, size], fees.freeNetLimit, fees) + fees.activationFee;
  return await trxInTokenUnits(charged, deps);
}

// ---------- Saved state ----------

const u64 = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const signedSchema = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  hex: z.string().regex(/^[0-9a-f]+$/),
  expiration: z.number().int().positive(),
});
const stateSchema = z.object({
  v: z.literal(1),
  mode: z.literal("trc20"),
  phase: z.enum(["top_up", "transfers"]),
  /** Sun the gas wallet plans to spend: the top-up plus its own fee. */
  plannedGasSpend: u64,
  /** Sun the merchant is charged for (fix ticket F); absent in payouts saved before it. */
  charged: u64.optional(),
  topUp: z
    .object({
      gasWallet: z.string(),
      amount: u64,
      signed: signedSchema,
      /** Once it landed: what it really took from the gas wallet (amount + fee). */
      spent: u64.optional(),
    })
    .optional(),
  /** Destination first, then the platform (if it gets anything). */
  transfers: z
    .array(
      z.object({
        kind: z.enum(["merchant_payout", "refund_route", "swap_deposit", "platform_fee"]),
        to: z.string(),
        amount: u64,
        feeLimit: u64,
        signed: signedSchema.optional(),
      }),
    )
    .min(1),
  /** The deposit's TRX left after the transfers, back to the gas wallet; "none": decided not to. */
  sweep: z
    .union([z.literal("none"), z.object({ to: z.string(), amount: u64, signed: signedSchema })])
    .optional(),
});
type TronState = z.infer<typeof stateSchema>;
type PlannedTransfer = TronState["transfers"][number];

function readState(raw: string): TronState | undefined {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function checkpointOf(state: TronState, depositAddress: string, platformFee: bigint, reimbursement: bigint): PayoutCheckpoint {
  const transfers: Transfer[] = [];
  if (state.topUp) {
    transfers.push({
      kind: "gas_top_up",
      to: depositAddress,
      // In sun. The others are in token units.
      amount: BigInt(state.topUp.spent ?? state.plannedGasSpend),
      txid: state.topUp.signed.txid,
    });
  }
  for (const t of state.transfers) {
    transfers.push({ kind: t.kind, to: t.to, amount: BigInt(t.amount), txid: t.signed?.txid ?? "" });
  }
  // networkCost in token units: the gas wallet's planned spend, converted.
  return { state: JSON.stringify(state), plan: { transfers, platformFee, networkCost: reimbursement } };
}

// ---------- Payout ----------

type Context = {
  request: PayoutRequest;
  deps: TronPayoutDeps;
  lifetime: number;
  platformFee: bigint;
  reimbursement: bigint;
};

const pending = (reason: string, review?: string): PayoutResult => ({ status: "pending", reason, ...(review !== undefined && { review }) });
const stillAt = (request: PayoutRequest) => `The USDT is still at deposit address ${request.depositAddress}.`;

function stopped(request: Pick<PayoutRequest, "depositAddress">, reason: string, transfers: Transfer[] = []): PayoutResult {
  return {
    status: "failed",
    message: `Tron payout stopped: ${reason}. ${transfers.length === 0 ? "Nothing was sent: all funds are still" : "The tokens are still"} at deposit address ${request.depositAddress}. Fix the cause, then set the invoice back to "confirmed" to retry, or move the funds by hand with the deposit key.`,
    transfers,
  };
}

function openKey(purpose: "tron-deposit-key" | "tron-gas-wallet-key", sealed: SealedSecret): { key: string; address: string } | undefined {
  try {
    const wallet = new Wallet(openSecret(purpose, sealed));
    return { key: wallet.privateKey, address: tronAddressFromEvm(wallet.address) };
  } catch {
    return undefined;
  }
}

function depositKeyOf(request: Pick<PayoutRequest, "depositAddress" | "depositKey">): string | PayoutResult {
  if (request.depositKey.kind !== "sealed_key") return stopped(request, "the deposit private key is missing");
  const opened = openKey("tron-deposit-key", request.depositKey.sealed);
  if (opened === undefined) return stopped(request, "the stored deposit key can't be opened");
  if (opened.address !== request.depositAddress) {
    return stopped(request, `the stored key opens ${opened.address}, not the deposit address. Do not retry; investigate the key storage`);
  }
  return opened.key;
}

function gasWalletOf(deps: TronPayoutDeps, request: PayoutRequest): { key: string; address: string } | PayoutResult {
  if (deps.gasWalletKey === undefined) {
    return pending(
      "TRX gas wallet is not configured",
      `The TRX gas wallet key is not configured, so this USDT payout can't pay its network fees and waits. Nothing was sent. ${stillAt(request)} Set TRX_GAS_WALLET_KEY in the server config.`,
    );
  }
  const opened = openKey("tron-gas-wallet-key", deps.gasWalletKey);
  if (opened === undefined) {
    return pending(
      "TRX gas wallet key can't be opened",
      `The TRX gas wallet key can't be opened with the current data key, so this USDT payout waits. Nothing was sent. ${stillAt(request)}`,
    );
  }
  return opened;
}

/** The token side of ChainAdapter.payout (src/chains/adapter.ts). Never touches the database. */
export async function payOutTronToken(request: PayoutRequest, deps: TronPayoutDeps): Promise<PayoutResult> {
  const lifetime = deps.txLifetimeMs ?? DEFAULT_TX_LIFETIME_MS;
  if (request.checkpoint !== undefined) {
    const state = readState(request.checkpoint.state);
    if (state === undefined) {
      return pending(
        "unreadable saved Tron payout",
        `The saved Tron payout is unreadable. Funds may still be at deposit address ${request.depositAddress}; check a block explorer before sending anything.`,
      );
    }
    const { platformFee, networkCost } = request.checkpoint.plan;
    return await follow({ request, deps, lifetime, platformFee, reimbursement: networkCost }, state);
  }
  return await planPayout(request, deps, lifetime);
}

async function planPayout(request: PayoutRequest, deps: TronPayoutDeps, lifetime: number): Promise<PayoutResult> {
  const { api, token } = deps;
  const { depositAddress, destination } = request;

  if (deps.platformAddress === undefined || !isValidTronAddress(deps.platformAddress)) {
    return pending(
      "platform TRX address is not configured",
      `The platform Tron address is not configured, so this payout waits. Nothing was sent. ${stillAt(request)} Set PLATFORM_TRX_ADDRESS in the server config.`,
    );
  }
  const platform = deps.platformAddress;
  if (request.receiveAsset !== token.asset) return stopped(request, `a ${token.asset} deposit can't be paid out as ${request.receiveAsset}`);
  if (!isValidTronAddress(destination)) return stopped(request, `destination "${destination}" is not a valid Tron address`);
  if (destination === depositAddress) return stopped(request, "the destination is the deposit address itself");
  if (destination === token.contract) {
    return stopped(request, `the destination is the ${token.asset} token contract, where tokens are lost. Ask the merchant for their wallet address`);
  }
  const depositKey = depositKeyOf(request);
  if (typeof depositKey !== "string") return depositKey;
  const gas = gasWalletOf(deps, request);
  if ("status" in gas) return gas;

  const received = await tokenBalance(api, token.contract, depositAddress);
  if (received === undefined) return pending("deposit token balance unavailable");
  if (received === 0n || received < request.minimumAmount) return pending("the deposit holds less than the payout minimum");

  const [deposit, fees, head] = await Promise.all([accountOf(api, depositAddress), chainFees(api), nowBlock(api)]);
  if (deposit === undefined || fees === undefined || head === undefined) return pending("Tron node lookups failed");
  const free = await freeBandwidth(api, depositAddress, deposit.active, fees);
  if (free === undefined) return pending("Tron bandwidth lookup failed");

  const energies: bigint[] = [];
  for (const to of [destination, platform]) {
    const energy = await transferEnergy(api, token.contract, depositAddress, to, received);
    if (energy === undefined) return pending("Tron energy estimate unavailable");
    if (energy === "reverted") {
      return pending(
        "the token contract refuses a transfer from the deposit",
        `A simulated ${token.asset} transfer from deposit address ${depositAddress} to ${to} is refused by the token contract (a frozen or blacklisted address?). Nothing was sent. ${stillAt(request)} Check the address on a block explorer.`,
      );
    }
    energies.push(energy);
  }

  const callTo = (to: string, energy: bigint) =>
    ({ kind: "trc20_transfer", from: depositAddress, contract: token.contract, to, amount: received, feeLimit: feeLimitFor(energy, fees) }) as const;
  const calls = [callTo(destination, energies[0]!), callTo(platform, energies[1]!)];

  // TRX already at the deposit (a payer's, or what an earlier payout could
  // not sweep) counts towards the burn and lowers the charge.
  const plan = async (transferCount: 1 | 2) => {
    const used = calls.slice(0, transferCount);
    const needed = used.reduce((sum, call) => sum + transferBurn(call, fees, head, lifetime), 0n);
    const topUp = needed > deposit.balance ? needed - deposit.balance : 0n;
    const ownFee = topUp === 0n ? 0n : topUpFee(deposit.active, fees, { from: gas.address, to: depositAddress, amount: topUp }, head, lifetime);
    const gasSpend = topUp + ownFee;
    const estimatedBurn =
      energies.slice(0, transferCount).reduce((sum, energy) => sum + energy * fees.energyFee, 0n) +
      bandwidthBurn(used.map((call) => transferSize(call, head, lifetime)), free, fees);
    const charged = topUp === 0n ? 0n : (estimatedBurn > deposit.balance ? estimatedBurn - deposit.balance : 0n) + ownFee;
    const reimbursement = await trxInTokenUnits(charged, deps);
    if (reimbursement === undefined) return undefined;
    return { topUp, gasSpend, charged, reimbursement, split: splitPayout({ received, networkCost: reimbursement, feeRate: request.feeRate, feeExempt: request.feeExempt ?? 0n }) };
  };
  const tooSmall: PayoutResult = { status: "too_small", reason: `${token.asset} payout is too small after the fee and the TRX network cost` };
  let planned = await plan(2);
  if (planned === undefined) return pending(`no TRX/${token.asset} price to convert the network cost`);
  if (planned.split === undefined) return tooSmall;
  if (planned.split.platformFee + planned.reimbursement === 0n) {
    // Nothing for the platform: one transfer, so less TRX is needed.
    planned = await plan(1);
    if (planned === undefined) return pending(`no TRX/${token.asset} price to convert the network cost`);
    if (planned.split === undefined) return tooSmall;
  }
  const { topUp, gasSpend, charged, reimbursement } = planned;
  const split = planned.split!;
  const platformAmount = split.platformFee + reimbursement;

  const transfers: PlannedTransfer[] = [
    { kind: request.destinationKind, to: destination, amount: split.merchantAmount.toString(), feeLimit: calls[0]!.feeLimit.toString() },
  ];
  if (platformAmount > 0n) {
    transfers.push({ kind: "platform_fee", to: platform, amount: platformAmount.toString(), feeLimit: calls[1]!.feeLimit.toString() });
  }
  const ctx: Context = { request, deps, lifetime, platformFee: split.platformFee, reimbursement };
  const base: TronState = { v: 1, mode: "trc20", phase: "transfers", plannedGasSpend: gasSpend.toString(), charged: charged.toString(), transfers };

  if (topUp === 0n) return await sendTransfers(ctx, base, depositKey);

  const signed = await signTopUp(ctx, gas, topUp, gasSpend);
  if ("status" in signed) return signed;
  const state: TronState = { ...base, phase: "top_up", topUp: { gasWallet: gas.address, amount: topUp.toString(), signed } };
  if (!(await request.saveCheckpoint(checkpointOf(state, depositAddress, ctx.platformFee, reimbursement)))) {
    return pending("another run saved this payout first");
  }
  await broadcast(api, signed);
  return pending("gas top-up sent; waiting for it to land");
}

/** Signs the gas wallet's top-up, after checking it can pay the planned spend. */
async function signTopUp(ctx: Context, gas: { key: string; address: string }, amount: bigint, spend: bigint): Promise<SignedTronTx | PayoutResult> {
  const { api } = ctx.deps;
  const [account, head] = await Promise.all([accountOf(api, gas.address), nowBlock(api)]);
  if (account === undefined || head === undefined) return pending("TRX gas wallet lookup failed");
  if (account.balance < spend) {
    return pending(
      "TRX gas wallet is short of funds",
      `The TRX gas wallet ${gas.address} holds ${account.balance} sun and this USDT payout's top-up needs ${spend}. Fund the gas wallet; the payout continues by itself. ${stillAt(ctx.request)}`,
    );
  }
  return signTronTx({ kind: "trx", from: gas.address, to: ctx.request.depositAddress, amount }, gas.key, {
    ref: head,
    expiration: head.timestamp + ctx.lifetime,
    now: Date.now(),
  });
}

/** Signs the deposit's transfers (its TRX is there), saves, then sends them. */
async function sendTransfers(ctx: Context, state: TronState, depositKey: string): Promise<PayoutResult> {
  const { api, token } = ctx.deps;
  const { request } = ctx;
  const [head, balance] = await Promise.all([nowBlock(api), tokenBalance(api, token.contract, request.depositAddress)]);
  if (head === undefined || balance === undefined) return pending("Tron node lookups failed");
  const total = state.transfers.reduce((sum, t) => sum + BigInt(t.amount), 0n);
  if (balance < total) {
    return pending(
      "the deposit holds less than this payout planned",
      `Deposit address ${request.depositAddress} holds ${balance} ${token.asset} units, but this payout planned to send ${total}. Nothing was sent now; check the address on a block explorer before retrying.`,
    );
  }
  const next: TronState = {
    ...state,
    phase: "transfers",
    transfers: state.transfers.map((t) => ({ ...t, signed: signTransfer(ctx, t, depositKey, head) })),
  };
  if (!(await request.saveCheckpoint(checkpointOf(next, request.depositAddress, ctx.platformFee, ctx.reimbursement)))) {
    return pending("another run saved this payout first");
  }
  for (const t of next.transfers) await broadcast(api, t.signed!);
  return pending("USDT transfers sent; waiting for them to land");
}

function signTransfer(ctx: Context, t: PlannedTransfer, depositKey: string, head: RefBlock): SignedTronTx {
  return signTronTx(
    {
      kind: "trc20_transfer",
      from: ctx.request.depositAddress,
      contract: ctx.deps.token.contract,
      to: t.to,
      amount: BigInt(t.amount),
      feeLimit: BigInt(t.feeLimit),
    },
    depositKey,
    { ref: head, expiration: head.timestamp + ctx.lifetime, now: Date.now() },
  );
}

async function follow(ctx: Context, state: TronState): Promise<PayoutResult> {
  if (state.phase === "top_up") return await followTopUp(ctx, state);
  return await followTransfers(ctx, state);
}

async function followTopUp(ctx: Context, state: TronState): Promise<PayoutResult> {
  const { api } = ctx.deps;
  const { request } = ctx;
  const topUp = state.topUp;
  if (topUp === undefined) {
    return pending("saved Tron top-up is missing", `The saved Tron payout is in its top-up phase without a top-up (a bug). ${stillAt(request)}`);
  }
  // Proof only from the solidified chain: those blocks can't be undone.
  const found = await savedTxFate(api, topUp.signed, ctx.deps.lostMarginMs ?? DEFAULT_LOST_MARGIN_MS);
  if (found.fate === "wait") return pending(found.reason);
  if (found.fate === "can_land") {
    await broadcast(api, topUp.signed);
    return pending("gas top-up sent; waiting for it to be solidified");
  }

  if (found.fate === "lost") {
    // Expired and not in any solidified block: it can never land.
    const gas = gasWalletOf(ctx.deps, request);
    if ("status" in gas) return gas;
    if (gas.address !== topUp.gasWallet) {
      return pending(
        "the gas wallet changed",
        `Gas top-up ${topUp.signed.txid} expired, and the configured TRX gas wallet is not the one that signed it. ${stillAt(request)} Review before retrying.`,
      );
    }
    const rebuilt = await signTopUp(ctx, gas, BigInt(topUp.amount), BigInt(state.plannedGasSpend));
    if ("status" in rebuilt) return rebuilt;
    const next: TronState = { ...state, topUp: { ...topUp, signed: rebuilt } };
    if (!(await request.saveCheckpoint(checkpointOf(next, request.depositAddress, ctx.platformFee, ctx.reimbursement)))) {
      return pending("another run saved this payout first");
    }
    await broadcast(api, rebuilt);
    return pending("expired gas top-up rebuilt and sent");
  }

  const depositKey = depositKeyOf(request);
  if (typeof depositKey !== "string") return depositKey;
  const spent = BigInt(topUp.amount) + BigInt(found.info.fee ?? 0);
  return await sendTransfers(ctx, { ...state, topUp: { ...topUp, spent: spent.toString() } }, depositKey);
}

async function followTransfers(ctx: Context, state: TronState): Promise<PayoutResult> {
  const { api, token } = ctx.deps;
  const { request } = ctx;
  const moved: Transfer[] = state.topUp
    ? [{ kind: "gas_top_up", to: request.depositAddress, amount: BigInt(state.topUp.spent ?? state.plannedGasSpend), txid: state.topUp.signed.txid }]
    : [];
  const notes: string[] = [];
  const missing: PlannedTransfer[] = [];
  const expired: PlannedTransfer[] = [];
  let waiting: string | undefined;

  for (const t of state.transfers) {
    if (t.signed === undefined) {
      return pending("saved Tron transfer is not signed", `The saved Tron payout is in its transfer phase without a signed transfer (a bug). ${stillAt(request)}`);
    }
    const found = await savedTxFate(api, t.signed, ctx.deps.lostMarginMs ?? DEFAULT_LOST_MARGIN_MS);
    if (found.fate === "wait") {
      waiting ??= found.reason;
      continue;
    }
    if (found.fate !== "landed") {
      missing.push(t);
      if (found.fate === "lost") expired.push(t);
      continue;
    }
    const { info } = found;
    if (info.receipt?.result !== "SUCCESS") {
      const outcome = info.receipt?.result ?? "no result";
      if (t.kind === "platform_fee") {
        notes.push(`Platform transfer ${t.signed.txid} failed on chain (${outcome}): its TRX fee was burned, but no ${token.asset} moved. The platform's ${t.amount} is still at deposit address ${request.depositAddress}; send it by hand.`);
        continue;
      }
      return {
        status: "failed",
        message: `Tron payout stopped: transfer ${t.signed.txid} to ${t.to} failed on chain (${outcome}): its TRX fee was burned, but no ${token.asset} moved. The tokens are still at deposit address ${request.depositAddress}. Find out why, then pay out by hand with the deposit key.`,
        transfers: moved,
      };
    }
    const delivered = deliveredByLogs(info, token.contract, t.to, request.depositAddress);
    moved.push({ kind: t.kind, to: t.to, amount: delivered, txid: t.signed.txid });
  }

  if (missing.length > 0) {
    if (expired.length === 0) {
      for (const t of missing) await broadcast(api, t.signed!);
      return pending("USDT transfers sent; waiting for them to be solidified");
    }
    // Expired and in no solidified block: they can never land. Rebuild
    // those, save, then send.
    const depositKey = depositKeyOf(request);
    if (typeof depositKey !== "string") return depositKey;
    const head = await nowBlock(api);
    if (head === undefined) return pending("Tron block unavailable");
    const next: TronState = {
      ...state,
      transfers: state.transfers.map((t) => (expired.includes(t) ? { ...t, signed: signTransfer(ctx, t, depositKey, head) } : t)),
    };
    if (!(await request.saveCheckpoint(checkpointOf(next, request.depositAddress, ctx.platformFee, ctx.reimbursement)))) {
      return pending("another run saved this payout first");
    }
    for (const t of next.transfers) if (missing.some((m) => m.kind === t.kind)) await broadcast(api, t.signed!);
    return pending("expired USDT transfers rebuilt and sent");
  }
  if (waiting !== undefined) return pending(waiting);

  for (const transfer of moved) {
    const planned = state.transfers.find((t) => t.signed?.txid === transfer.txid);
    if (planned === undefined || BigInt(planned.amount) === transfer.amount) continue;
    if (transfer.kind === "platform_fee") {
      notes.push(`Platform transfer ${transfer.txid} delivered ${transfer.amount}, not the planned ${planned.amount}.`);
      continue;
    }
    return {
      status: "failed",
      message: `Tron payout: transfer ${transfer.txid} to ${transfer.to} landed but delivered ${transfer.amount}, not the planned ${planned.amount}. Anything not delivered is still at deposit address ${request.depositAddress}. Check the token's transfer rules, then settle the difference by hand.`,
      transfers: moved,
    };
  }
  return { status: "paid", transfers: moved, ...(notes.length > 0 && { note: notes.join(" ") }) };
}

// A sweep that can't land soon is given up sooner: nothing waits for it, but
// it is followed until it lands or is proven lost.
const SWEEP_LIFETIME_MS = 2 * 60_000;

/**
 * The adapter's afterPayout, once the payout is proven: sends what is left
 * of the top-up at the deposit back to the gas wallet, saved before it is
 * sent. Only a payout that topped up sweeps (other TRX at the deposit is not
 * the platform's), and only when the sweep brings back more than its
 * bandwidth would burn. It never touches the payout: a sweep that can never
 * land is left out, never rebuilt, and the TRX stays at the deposit.
 */
export async function sweepTronDeposit(request: AfterPayoutRequest, deps: TronPayoutDeps): Promise<AfterPayoutResult> {
  const { api } = deps;
  const done = (transfers: Transfer[] = []): AfterPayoutResult => ({ status: "done", transfers });
  const waiting = (reason: string): AfterPayoutResult => ({ status: "pending", reason });
  const state = readState(request.state);
  if (state === undefined || state.phase !== "transfers" || state.topUp === undefined || state.sweep === "none") return done();

  if (state.sweep !== undefined) {
    const sweep = state.sweep;
    const found = await savedTxFate(api, sweep.signed, deps.lostMarginMs ?? DEFAULT_LOST_MARGIN_MS);
    if (found.fate === "wait") return waiting(found.reason);
    if (found.fate === "lost") return done();
    if (found.fate === "can_land") {
      await broadcast(api, sweep.signed);
      return waiting("gas sweep sent; waiting for it to be solidified");
    }
    return done([{ kind: "gas_sweep", to: sweep.to, amount: BigInt(sweep.amount), txid: sweep.signed.txid }]);
  }

  const to = state.topUp.gasWallet;
  const [account, fees, head] = await Promise.all([accountOf(api, request.depositAddress), chainFees(api), nowBlock(api)]);
  if (account === undefined || fees === undefined || head === undefined) return waiting("Tron node lookups failed");
  const free = await freeBandwidth(api, request.depositAddress, account.active, fees);
  if (free === undefined) return waiting("Tron bandwidth lookup failed");
  const lifetime = Math.min(deps.txLifetimeMs ?? DEFAULT_TX_LIFETIME_MS, SWEEP_LIFETIME_MS);
  // The size with the whole balance as the amount: no smaller amount is longer.
  const size = transferSize({ kind: "trx", from: request.depositAddress, to, amount: account.balance }, head, lifetime);
  const amount = account.balance - bandwidthBurn([size], free, fees);
  const save = async (next: TronState) => await request.saveState(JSON.stringify(next));

  if (amount <= size * fees.bytesFee) {
    // The decision is saved, so a later call answers the same.
    if (!(await save({ ...state, sweep: "none" }))) return waiting("another run saved this sweep first");
    return done();
  }
  const depositKey = depositKeyOf(request);
  if (typeof depositKey !== "string") return done();
  const signed = signTronTx({ kind: "trx", from: request.depositAddress, to, amount }, depositKey, {
    ref: head,
    expiration: head.timestamp + lifetime,
    now: Date.now(),
  });
  if (!(await save({ ...state, sweep: { to, amount: amount.toString(), signed } }))) return waiting("another run saved this sweep first");
  await broadcast(api, signed);
  return waiting("gas sweep sent; waiting for it to be solidified");
}
