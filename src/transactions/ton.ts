import {
  Address,
  beginCell,
  Cell,
  external,
  internal,
  loadTransaction,
  SendMode,
  storeMessage,
} from "@ton/core";
import { mnemonicToPrivateKey, mnemonicValidate } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";
import { z } from "zod";
import type {
  ChainPayment,
  PayoutCheckpoint,
  PayoutRequest,
  PayoutResult,
  Transfer,
} from "../chains/adapter.js";
import { env } from "../config/env.js";
import { ceilDivide } from "../money/format.js";
import { splitPayout } from "../money/payout-split.js";
import { openSecret, type SealedSecret } from "../security/secret-envelope.js";
import { LATE_PAYMENT_NOTE_PREFIX } from "../swap/near.js";

// TON (native Toncoin only): payment lookup and payout.
// Network calls go through callTonApi() (NOWNodes, toncenter v2 API).
// @ton/ton and @ton/core only build and sign; they never talk to the network
// here.
//
// How TON differs from the other chains:
// - A wallet is a smart contract. A deposit address has no code until its
//   first payout, which deploys it (the code rides along in that message).
// - The deposit wallet pays its own fee, from its own balance.
// - A payout is ONE transaction with two messages, both with +2 (ignore
//   errors; W5 refuses signed messages without it):
//     1. the receiver (merchant, or NEAR for a swap) gets an exact amount,
//        fee paid on top (mode 1 + 2 = 3);
//     2. the platform gets everything left (mode 128 + 2 = 130): the
//        platform fee plus the part of the fee budget the chain did not use.
// - seqno: each signed message carries the wallet's next seqno, and the
//   wallet accepts each seqno once. Two messages with the same seqno can
//   never both land. That is what makes a rebuild safe.
// - valid_until: after this time a signed message can never land.
// - Every payout message is non-bounceable. TON delivers every message, and
//   a non-bounceable one stays in the receiver's balance even if its code
//   fails. So once our transaction sent it, the receiver has it. (Bounceable
//   would send it back to us if the receiver's code failed.)

const TON_API_URL = "https://ton.nownodes.io/api/v2";

// What one payout may cost in fees, in nanoton (1 TON = 10^9 nanoton).
// Estimated with toncenter's fee estimator on 2026-11-10: about 1,300,000
// for a first payout (deploys the wallet, two messages), about 700,000 for
// a wallet that is already deployed. The merchant is charged this budget as
// the network fee; whatever the chain does not use goes to the platform in
// message 2.
export const TON_PAYOUT_FEE = 5_000_000n;

// An account with no code (a deposit address before its payout) pays a
// storage fee each time a payment arrives: a few nanoton for the time since
// the last one. So a payer who pays in two parts ends a few nanoton short.
// The fee grows with time, and payments can only arrive while the invoice is
// open, so the allowance follows the invoice lifetime.
// Measured on mainnet on 2026-11-10: 7.42 nanoton per hour. Allow 10 times
// that; the merchant gets that much less.
const TON_SHORTFALL_PER_HOUR = 75n;

// The smallest balance that counts as "paid in full" for an invoice amount.
// The watcher (invoice.function.ts) and the payout both use this.
// 30-minute invoice: up to 38 nanoton short. 60 minutes: up to 75.
export function tonMinimumPayment(
  invoiceAmount: bigint,
  lifetimeMinutes: number,
): bigint {
  if (!Number.isFinite(lifetimeMinutes) || lifetimeMinutes <= 0) {
    return invoiceAmount;
  }
  const allowance = ceilDivide(
    BigInt(Math.ceil(lifetimeMinutes)) * TON_SHORTFALL_PER_HOUR,
    60n,
  );
  return invoiceAmount > allowance ? invoiceAmount - allowance : invoiceAmount;
}

// A signed payout is valid this long after the chain time it was built at.
export const TX_LIFETIME_SECONDS = 300;
// Wait this much past valid_until before deciding a message can never land.
// A shard block from just before valid_until can reach the masterchain a few
// seconds later.
export const EXPIRY_MARGIN_SECONDS = 60;
// A deposit wallet has few transactions (payments in, one payout out).
const RECENT_TX_LIMIT = 20;

// Merchant fee rates have 8 decimals: "0.005" = 0.5% = 500,000 / 10^8.
const FEE_RATE_DECIMALS = 8;
const FEE_RATE_SCALE = 10n ** BigInt(FEE_RATE_DECIMALS);

// Amounts (nanoton) come as integer strings.
const u64String = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const accountStateSchema = z.enum(["active", "uninitialized", "frozen"]);
type AccountState = z.infer<typeof accountStateSchema>;

// ---------- Addresses ----------

// EQ…/UQ… form only: it has a checksum, so a typo is caught. Mainnet,
// workchain 0 (where all normal wallets live).
export function parseTonAddress(value: string): Address | undefined {
  try {
    const parsed = Address.parseFriendly(value);
    if (parsed.isTestOnly || parsed.address.workChain !== 0) return undefined;
    return parsed.address;
  } catch {
    return undefined;
  }
}

export function isValidTonAddress(value: string): boolean {
  return parseTonAddress(value) !== undefined;
}

// One account has two text forms (EQ… bounceable, UQ… non-bounceable), so
// compare parsed addresses, never strings.
export function sameTonAccount(a: string, b: string): boolean {
  const x = parseTonAddress(a);
  const y = parseTonAddress(b);
  return x !== undefined && y !== undefined && x.equals(y);
}

// ---------- API (toncenter v2 format, served by NOWNodes) ----------

/** One toncenter v2 call: its `result`, or undefined when the call failed. */
export type TonApi = (
  method: string,
  request: { query?: Record<string, string>; body?: unknown },
) => Promise<unknown>;

// undefined = failed (retry later). Never logs the query or body: for
// sendBoc the body is the signed message.
async function callTonApi(
  method: string,
  request: { query?: Record<string, string>; body?: unknown },
): Promise<unknown> {
  const url = new URL(`${TON_API_URL}/${method}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const isPost = request.body !== undefined;

  try {
    const res = await fetch(url, {
      method: isPost ? "POST" : "GET",
      headers: {
        "api-key": env.nowNodesApiKey,
        Accept: "application/json",
        ...(isPost ? { "Content-Type": "application/json" } : {}),
      },
      body: isPost ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });

    const body: unknown = await res.json().catch(() => undefined);

    const failure = z
      .object({ ok: z.literal(false), error: z.string() })
      .safeParse(body);
    if (failure.success) {
      console.warn("TON API error:", method, res.status, failure.data.error.slice(0, 200));
      return undefined;
    }
    if (!res.ok) {
      console.warn("TON API HTTP failed:", method, res.status);
      return undefined;
    }

    const success = z
      .object({ ok: z.literal(true), result: z.unknown() })
      .safeParse(body);
    if (!success.success) {
      console.warn("TON API answer has an unexpected shape:", method);
      return undefined;
    }
    return success.data.result;
  } catch (error) {
    console.warn(
      "TON API request failed:",
      method,
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

export const nowNodesTonApi: TonApi = callTonApi;

// One consistent snapshot of an account: balance, code, data, and the chain
// time of that snapshot. A never-used address answers "uninitialized" with
// balance 0. TON has no reorgs: once the API shows a state, it is final.
export async function getTonAccount(api: TonApi, address: Address) {
  const parsed = z
    .object({
      balance: u64String,
      state: accountStateSchema,
      code: z.string(),
      data: z.string(),
      sync_utime: z.number().int().positive(),
    })
    .safeParse(
      await api("getAddressInformation", {
        query: { address: address.toString() },
      }),
    );
  if (!parsed.success) return undefined;

  let code: Cell | undefined;
  let data: Cell | undefined;
  try {
    code = parsed.data.code ? Cell.fromBase64(parsed.data.code) : undefined;
    data = parsed.data.data ? Cell.fromBase64(parsed.data.data) : undefined;
  } catch {
    console.warn("TON account code or data is not a valid cell:", address.toString());
    return undefined;
  }

  return {
    balance: BigInt(parsed.data.balance),
    state: parsed.data.state,
    code,
    data,
    chainTime: parsed.data.sync_utime,
  };
}

// For a receiver: is it a normal wallet, and is it deployed?
// wallet = the API recognises the code as a standard wallet (v1–v5).
export async function getTonDestination(api: TonApi, address: Address) {
  const parsed = z
    .object({ wallet: z.boolean(), account_state: accountStateSchema })
    .safeParse(
      await api("getWalletInformation", {
        query: { address: address.toString() },
      }),
    );
  if (!parsed.success) return undefined;
  return { isWallet: parsed.data.wallet, state: parsed.data.account_state };
}

// The newest transactions of an account, each as a base64 BOC.
export async function getRecentTonTransactions(api: TonApi, address: Address, limit = RECENT_TX_LIMIT) {
  const parsed = z
    .array(z.object({ data: z.string().min(1) }))
    .safeParse(
      await api("getTransactions", {
        query: { address: address.toString(), limit: String(limit) },
      }),
    );
  return parsed.success ? parsed.data.map((tx) => tx.data) : undefined;
}

// Sending the same signed message again is safe: its seqno can be used once.
export async function sendTonMessage(api: TonApi, boc: string): Promise<boolean> {
  return (await api("sendBoc", { body: { boc } })) !== undefined;
}

// ---------- Wallet ----------

export type TonWallet = { contract: WalletContractV5R1; secretKey: Buffer };

// The key is the 24-word mnemonic (see crypto/ton.ts).
export async function loadTonWallet(secret: string): Promise<TonWallet> {
  const words = secret.split(" ");
  if (!(await mnemonicValidate(words))) {
    throw new Error("the saved key is not a valid TON mnemonic");
  }
  const keyPair = await mnemonicToPrivateKey(words);
  return {
    contract: WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey }),
    secretKey: keyPair.secretKey,
  };
}

// W5 data: signature allowed (1 bit), seqno (32), wallet id (32),
// public key (256), extensions.
function readW5Data(data: Cell) {
  try {
    const slice = data.beginParse();
    const signatureAllowed = slice.loadBit();
    const seqno = slice.loadUint(32);
    slice.skip(32);
    return { signatureAllowed, seqno, publicKey: slice.loadBuffer(32) };
  } catch {
    return undefined;
  }
}

// The seqno the next signed message must carry. A never-deployed wallet
// starts at 0. undefined = can't tell.
export function readSeqno(account: { state: AccountState; data?: Cell }) {
  if (account.state === "uninitialized") return 0;
  if (account.state !== "active" || !account.data) return undefined;
  return readW5Data(account.data)?.seqno;
}

// A deployed deposit wallet must run exactly our W5 code with our public
// key; anything else is a problem for a person.
export function readDepositWallet(
  account: { state: AccountState; code?: Cell; data?: Cell },
  wallet: WalletContractV5R1,
): { seqno: number; deployed: boolean } | { problem: string } {
  if (account.state === "frozen") {
    return { problem: "the deposit wallet is frozen (its storage fees were not paid)" };
  }
  if (account.state === "uninitialized") return { seqno: 0, deployed: false };

  if (!account.code || !account.data || !account.code.hash().equals(wallet.init.code.hash())) {
    return { problem: "the deposit address runs code that is not our W5 wallet" };
  }
  const data = readW5Data(account.data);
  if (data === undefined) {
    return { problem: "the deposit wallet's data could not be read" };
  }
  if (!data.signatureAllowed || !data.publicKey.equals(wallet.publicKey)) {
    return { problem: "the deposit wallet does not accept our key" };
  }
  return { seqno: data.seqno, deployed: true };
}

// ---------- Payment lookup ----------

// A deposit address has a handful of transactions. A full page is treated as
// a listing that may be missing some.
const PAYMENT_LIST_LIMIT = 100;

// The value one transaction credited to the account and kept. A payment sent
// "bounceable" to the new (code-less) deposit address goes back to the payer
// (bounce phase "ok"), so it is not a payment; that is why the address is
// shown in its UQ… form. The amount is what was credited, so a storage fee
// taken from the balance between two payments does not count against the
// payer.
function readIncomingPayment(data: string): ChainPayment | null | undefined {
  let root: Cell;
  let tx: ReturnType<typeof loadTransaction>;
  try {
    root = Cell.fromBase64(data);
    tx = loadTransaction(root.beginParse());
  } catch {
    return undefined;
  }
  if (tx.inMessage?.info.type !== "internal") return null;
  const d = tx.description;
  if (d.type !== "generic") return null;
  const credited = d.creditPhase?.credit.coins ?? 0n;
  if (credited <= 0n || d.bouncePhase?.type === "ok") return null;
  return {
    txid: root.hash().toString("hex"),
    amount: credited,
    // TON has no reorgs: a transaction the API shows is final.
    confirmations: 1,
    seenAt: tx.now * 1000,
  };
}

// For the invoice watcher: every payment a deposit address received.
// undefined = failed or possibly incomplete; retry later.
export async function getTonPayments(
  api: TonApi,
  depositAddress: string,
): Promise<ChainPayment[] | undefined> {
  const address = parseTonAddress(depositAddress);
  if (address === undefined) return undefined;

  const transactions = await getRecentTonTransactions(api, address, PAYMENT_LIST_LIMIT);
  if (transactions === undefined) return undefined;
  if (transactions.length >= PAYMENT_LIST_LIMIT) {
    console.warn("TON payment listing may be incomplete:", depositAddress);
    return undefined;
  }

  const payments: ChainPayment[] = [];
  for (const data of transactions) {
    const payment = readIncomingPayment(data);
    if (payment === undefined) return undefined;
    if (payment !== null) payments.push(payment);
  }

  // Only fees and payouts lower a balance, so a balance above everything
  // listed as received means the listing is missing a payment.
  const account = await getTonAccount(api, address);
  if (account === undefined) return undefined;
  const listed = payments.reduce((sum, p) => sum + p.amount, 0n);
  if (account.balance > listed) {
    console.warn("TON deposit holds more than its listed payments:", depositAddress);
    return undefined;
  }
  return payments;
}

// ---------- Payout math (pure) ----------

// The receiver gets merchantAmount exactly. The fee budget and the platform
// fee stay behind and go to the platform in message 2, minus what the chain
// really charges.
function planTonPayout(total: bigint, feeRate: bigint) {
  if (total < 0n || feeRate < 0n || feeRate >= FEE_RATE_SCALE) {
    throw new RangeError("invalid TON payout input");
  }
  const split = splitPayout({ received: total, networkCost: TON_PAYOUT_FEE, feeRate });
  if (split === undefined) return undefined;

  return { networkFee: TON_PAYOUT_FEE, ...split };
}

// ---------- Signing ----------

// Builds the external message: the signed W5 request, plus the wallet's code
// if it is not deployed yet. Its hash is known before sending, so it can be
// saved first.
export function signW5External(input: {
  wallet: TonWallet;
  seqno: number;
  deploy: boolean;
  validUntil: number;
  messages: { mode: number; message: ReturnType<typeof internal> }[];
}) {
  const { contract, secretKey } = input.wallet;
  const body = contract.createRequest({
    seqno: input.seqno,
    secretKey,
    timeout: input.validUntil,
    actions: input.messages.map(({ mode, message }) => ({ type: "sendMsg" as const, mode, outMsg: message })),
  });

  const message = beginCell()
    .store(
      storeMessage(
        external({
          to: contract.address,
          init: input.deploy ? contract.init : undefined,
          body,
        }),
      ),
    )
    .endCell();

  return {
    boc: message.toBoc().toString("base64"),
    hash: message.hash().toString("hex"),
  };
}

// Both messages are non-bounceable (see the top of this file).
// Exported for tests (tests/transactions/ton-payout.test.ts).
export function signTonPayout(input: {
  wallet: TonWallet;
  seqno: number;
  deploy: boolean;
  validUntil: number;
  receiver: Address;
  amount: bigint;
  platform: Address;
}) {
  return signW5External({
    wallet: input.wallet,
    seqno: input.seqno,
    deploy: input.deploy,
    validUntil: input.validUntil,
    messages: [
      {
        mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        message: internal({ to: input.receiver, value: input.amount, bounce: false }),
      },
      {
        mode: SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.IGNORE_ERRORS,
        message: internal({ to: input.platform, value: 0n, bounce: false }),
      },
    ],
  });
}

// ---------- Prepare one payout ----------

type PreparedPayout =
  | { kind: "wait"; reason: string }
  | { kind: "too_small" }
  | { kind: "stop"; reason: string }
  | {
      kind: "ready";
      hash: string;
      boc: string;
      seqno: number;
      validUntil: number;
      // Who gets merchantAmount: the merchant, or NEAR for a swap.
      receiver: string;
      merchantAmount: bigint;
      networkFee: bigint;
      platformFee: bigint;
    };

export function notAWallet(address: string) {
  return `${address} is not a normal TON wallet (a common mistake is giving a USDT jetton wallet instead of the wallet address), so funds sent there could be locked`;
}

// Everything up to a signed message. Nothing is sent and nothing is saved.
// wait = temporary problem (retry next round), stop = permanent problem
// (needs a person). Problems with our own config throw.
async function prepareTonPayout(input: {
  api: TonApi;
  depositAddress: string;
  merchantAddress: string;
  platformAddress: string;
  feeRate: bigint;
  toCrypto: string;
  sealedDepositKey: SealedSecret | null | undefined;
  // The deposit must hold at least this much (the invoice amount).
  minimumTotal: bigint;
  // The invoice lifetime, for the storage-fee allowance.
  lifetimeMinutes: number;
}): Promise<PreparedPayout> {
  const { api, depositAddress, merchantAddress, platformAddress, feeRate } = input;
  const fundsAt = `All funds are still at deposit address ${depositAddress}.`;

  function wait(why: string): PreparedPayout {
    console.warn(`TON payout waiting (${why}); will retry:`, depositAddress);
    return { kind: "wait", reason: why };
  }
  function stop(reason: string): PreparedPayout {
    return { kind: "stop", reason: `Payout stopped: ${reason}` };
  }

  const toCrypto = input.toCrypto;
  if (toCrypto !== "ton") {
    return stop(`a TON deposit pays out only as ton, not "${toCrypto}". ${fundsAt} Fix to_crypto, then pay out manually.`);
  }

  const deposit = parseTonAddress(depositAddress);
  if (deposit === undefined) {
    return stop(`deposit address "${depositAddress}" is not a valid TON address. Check how this invoice was created before moving any funds.`);
  }

  // Our own config, not the invoice: throw, never fail the invoice.
  const platform = parseTonAddress(platformAddress);
  if (platform === undefined) {
    throw new Error("Platform TON address is not a valid mainnet TON address");
  }

  if (!isValidTonAddress(merchantAddress)) {
    return stop(`merchant payout address "${merchantAddress}" is not a valid mainnet TON address. ${fundsAt} Fix the merchant's TON address, then pay out manually.`);
  }
  if (sameTonAccount(merchantAddress, depositAddress)) {
    return stop(`merchant payout address is the deposit address itself. ${fundsAt} Fix the merchant's TON address, then pay out manually.`);
  }

  if (!input.sealedDepositKey) {
    return stop(`the deposit private key is missing from the database. ${fundsAt} Restore the key from backup; without it the funds cannot be moved.`);
  }

  let wallet: TonWallet;
  try {
    wallet = await loadTonWallet(openSecret("ton-deposit-key", input.sealedDepositKey));
  } catch (error) {
    return stop(`the deposit key could not be opened (${error instanceof Error ? error.message : "unknown error"}). Nothing was sent. ${fundsAt}`);
  }
  if (!wallet.contract.address.equals(deposit)) {
    return stop(`the saved key does not control deposit address ${depositAddress}. Nothing was sent. Find the right key before moving the funds.`);
  }

  const platformAccount = await getTonDestination(api, platform);
  if (platformAccount === undefined) return wait("platform account lookup failed");
  if (
    platformAccount.state === "frozen" ||
    (platformAccount.state === "active" && !platformAccount.isWallet)
  ) {
    throw new Error("PLATFORM_TON_ADDRESS is not a normal TON wallet");
  }

  const account = await getTonAccount(api, deposit);
  if (account === undefined) return wait("deposit account lookup failed");

  const walletState = readDepositWallet(account, wallet.contract);
  if ("problem" in walletState) {
    return stop(`${walletState.problem}. ${fundsAt} Investigate before moving anything.`);
  }

  if (account.balance < tonMinimumPayment(input.minimumTotal, input.lifetimeMinutes)) {
    return wait("the deposit holds less than expected");
  }

  const plan = planTonPayout(account.balance, feeRate);
  if (plan === undefined) return { kind: "too_small" };

  // Who receives: the merchant, or NEAR's deposit address for a swap.
  const receiverText = merchantAddress;

  const receiver = parseTonAddress(receiverText);
  if (receiver === undefined) throw new Error("receiver address was checked above");

  const destination = await getTonDestination(api, receiver);
  if (destination === undefined) return wait("receiver account lookup failed");
  const problem =
    destination.state === "frozen"
      ? `${receiverText} is frozen, so it can't receive`
      : destination.state === "active" && !destination.isWallet
        ? notAWallet(receiverText)
        : undefined;
  if (problem !== undefined) {
    return stop(`the merchant can't receive TON: ${problem}. ${fundsAt} Ask the merchant for another wallet address, then pay out manually.`);
  }

  // Valid until a time on the chain's clock, not ours.
  const validUntil = account.chainTime + TX_LIFETIME_SECONDS;

  try {
    const signed = signTonPayout({
      wallet,
      seqno: walletState.seqno,
      deploy: !walletState.deployed,
      validUntil,
      receiver,
      amount: plan.merchantAmount,
      platform,
    });
    return {
      kind: "ready",
      ...signed,
      seqno: walletState.seqno,
      validUntil,
      receiver: receiver.toRawString(),
      merchantAmount: plan.merchantAmount,
      networkFee: plan.networkFee,
      platformFee: plan.platformFee,
    };
  } catch (error) {
    return stop(`signing failed (${error instanceof Error ? error.message : "unknown error"}). Nothing was sent. ${fundsAt} Investigate before retrying.`);
  } finally {
    wallet.secretKey.fill(0);
  }
}

// ---------- Saved message ----------

// tx.out for TON holds the external message hash (hex): known before
// sending. tx.raw holds what is needed to resend it, to know when it expires,
// and to check what it paid.
const savedTonTxSchema = z.object({
  boc: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  seqno: z.number().int().nonnegative(),
  validUntil: z.number().int().positive(),
  receiver: z.string().regex(/^0:[0-9a-f]{64}$/),
  amount: u64String,
});

type ReadyPayout = Extract<PreparedPayout, { kind: "ready" }>;

// tx.raw holds the state; the plan fills tx.out (the message hash until the
// payout lands) and the fee fields.
function checkpointOf(
  prepared: ReadyPayout,
  destinationKind: Transfer["kind"],
  platform: Address,
): PayoutCheckpoint {
  return {
    state: JSON.stringify({
      boc: prepared.boc,
      seqno: prepared.seqno,
      validUntil: prepared.validUntil,
      receiver: prepared.receiver,
      amount: prepared.merchantAmount.toString(),
    }),
    plan: {
      transfers: [
        {
          kind: destinationKind,
          to: Address.parseRaw(prepared.receiver).toString({ bounceable: false }),
          amount: prepared.merchantAmount,
          txid: prepared.hash,
        },
        // Message 2 carries the platform fee plus whatever the fee budget
        // leaves over; the proof records what it really carried.
        {
          kind: "platform_fee",
          to: platform.toString({ bounceable: false }),
          amount: prepared.platformFee,
          txid: prepared.hash,
        },
      ],
      platformFee: prepared.platformFee,
      networkCost: prepared.networkFee,
    },
  };
}

function parseSavedTonTx(raw: string | undefined | null) {
  if (!raw) return undefined;
  try {
    const parsed = savedTonTxSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    return {
      ...parsed.data,
      receiver: Address.parseRaw(parsed.data.receiver),
      amount: BigInt(parsed.data.amount),
    };
  } catch {
    return undefined;
  }
}

// ---------- Finding a landed payout ----------

// Looks for the deposit wallet's transaction that used `seqno`. Only our key
// can sign for this wallet, so that transaction is our payout: this one, or
// an earlier signed version of it (they share the seqno, so at most one
// lands).
// Exported for tests (tests/transactions/ton-payout.test.ts).
export function findPayoutBySeqno(transactions: string[], seqno: number) {
  for (const data of transactions) {
    let root: Cell;
    let tx: ReturnType<typeof loadTransaction>;
    try {
      root = Cell.fromBase64(data);
      tx = loadTransaction(root.beginParse());
    } catch {
      continue;
    }

    const inMessage = tx.inMessage;
    if (inMessage?.info.type !== "external-in") continue;

    // Signed W5 request: opcode, wallet id, valid_until, seqno, actions,
    // then the signature.
    const body = inMessage.body.beginParse();
    if (body.remainingBits < 128) continue;
    if (body.loadUint(32) !== WalletContractV5R1.OpCodes.auth_signed_external) continue;
    body.skip(64);
    if (body.loadUint(32) !== seqno) continue;

    // The incoming message is the first reference of the transaction; its
    // hash is what was sent (and what tx.out holds).
    const messages = root.refs[0]?.beginParse();
    const messageHash = messages?.loadBit() ? messages.loadRef().hash().toString("hex") : "";

    // The messages this transaction really created. With +2 (ignore
    // errors) a message that could not be sent is simply missing here.
    const sent: SentMessage[] = [];
    const outgoing: OutgoingMessage[] = [];
    // What the wallet's balance lost in this transaction: its fees, plus each
    // message's value and the forwarding fee it paid for it.
    let spent = tx.totalFees.coins;
    for (const out of tx.outMessages.values()) {
      if (out.info.type === "internal") {
        sent.push({
          to: out.info.dest,
          value: out.info.value.coins,
          bounce: out.info.bounce,
        });
        outgoing.push({ ...sent[sent.length - 1]!, createdLt: out.info.createdLt, body: out.body });
        spent += out.info.value.coins + out.info.forwardFee + out.info.ihrFee;
      }
    }

    const d = tx.description;
    let failed: string | undefined;
    if (d.type !== "generic") failed = `unexpected transaction type ${d.type}`;
    else if (d.aborted) failed = "the transaction was aborted";
    else if (d.computePhase.type !== "vm" || !d.computePhase.success) {
      failed = "the wallet code did not run successfully";
    } else if (d.actionPhase && !d.actionPhase.success) failed = "the send step failed";

    return { txHash: root.hash().toString("hex"), messageHash, sent, outgoing, spent, failed };
  }
  return undefined;
}

type SentMessage = { to: Address; value: bigint; bounce: boolean };
export type OutgoingMessage = SentMessage & { createdLt: bigint; body: Cell };

// Did the landed payout really send `amount` to `receiver`, non-bounceable?
// Decided from the messages the transaction created, never from its status:
// with +2 a skipped message still leaves the transaction "successful".
export function paidExactly(
  sent: SentMessage[],
  receiver: Address,
  amount: bigint,
): boolean {
  return sent.some(
    (message) =>
      message.to.equals(receiver) && message.value === amount && !message.bounce,
  );
}

// The review note for a payout that landed but did not pay the receiver.
// Message 2 (mode 128) sends everything left to the platform, so the money
// is with the receiver, in the platform wallet, or still at the deposit.
function failedPayoutNote(input: {
  txHash: string;
  failed: string | undefined;
  sent: SentMessage[];
  receiver: Address;
  amount: bigint;
  platform: Address;
  // What message 2 carries at most when nothing went wrong.
  expectedToPlatform: bigint;
  depositAddress: string;
  depositBalance: bigint;
}): string {
  const text = (address: Address) => address.toString({ bounceable: false });
  const receiverText = text(input.receiver);
  const sumTo = (address: Address) =>
    input.sent
      .filter((message) => message.to.equals(address))
      .reduce((sum, message) => sum + message.value, 0n);

  const sentText =
    input.sent
      .map((m) => `${m.value} nanoton to ${text(m.to)}${m.bounce ? " (bounceable)" : ""}`)
      .join(", ") || "nothing";
  const lines = [
    `TON payout tx ${input.txHash} landed but did not pay ${input.amount} nanoton to ${receiverText}${input.failed ? ` (${input.failed})` : ""}.`,
    `It sent: ${sentText}.`,
    `Deposit address ${input.depositAddress} now holds ${input.depositBalance} nanoton.`,
  ];

  const missing = input.amount - sumTo(input.receiver);
  const toPlatform = sumTo(input.platform);
  if (missing > 0n && toPlatform > input.expectedToPlatform) {
    lines.push(
      `The platform message carried ${toPlatform} nanoton, more than the usual at most ${input.expectedToPlatform}: what the receiver did not get went to platform wallet ${text(input.platform)}. The merchant is owed ${missing} nanoton; pay it from the platform wallet to ${receiverText}.`,
    );
  }
  if (input.sent.some((message) => message.bounce)) {
    lines.push(
      "A bounceable message was sent (our code never signs one; this is a bug). If the receiver rejected it, the money came back to the deposit address: check the receiver's transaction on an explorer.",
    );
  }
  if (input.depositBalance > 0n) {
    lines.push(
      `${input.depositBalance} nanoton is still at the deposit address and needs the deposit key to move. Setting the invoice back to "confirmed" will not work: the payout waits for the full invoice amount.`,
    );
  }
  lines.push("Check the tx on an explorer before sending anything.");
  return lines.join(" ");
}

// ---------- The payout ----------

// Deposits only take payments while their invoice is open, at most this long
// (see tonMinimumPayment).
const MAX_INVOICE_LIFETIME_MINUTES = 60;

/**
 * The TON side of ChainAdapter.payout (src/chains/adapter.ts): pays
 * request.destination from the deposit, or follows the payout saved in
 * request.checkpoint. Never touches the database.
 */
export async function payOutTon(
  request: PayoutRequest,
  deps: { api: TonApi; platformAddress: string },
): Promise<PayoutResult> {
  const { api, platformAddress } = deps;
  const platform = parseTonAddress(platformAddress);
  if (platform === undefined) {
    throw new Error("Platform TON address is not a valid mainnet TON address");
  }
  const depositAddress = request.depositAddress;
  const pending = (reason: string): PayoutResult => ({ status: "pending", reason });

  if (request.depositKey.kind !== "sealed_key") {
    return {
      status: "failed",
      message: `Payout stopped: a TON deposit needs its own key, but this invoice has none. All funds are still at deposit address ${depositAddress}. Nothing was sent.`,
      transfers: [],
    };
  }
  const sealedDepositKey = request.depositKey.sealed;

  const prepare = () =>
    prepareTonPayout({
      api,
      depositAddress,
      merchantAddress: request.destination,
      platformAddress,
      feeRate: request.feeRate,
      toCrypto: request.receiveAsset,
      sealedDepositKey,
      // The same minimum the watcher confirmed at, tolerance included.
      minimumTotal: request.minimumAmount,
      lifetimeMinutes: MAX_INVOICE_LIFETIME_MINUTES,
    });

  // ----- nothing saved yet: sign, save, then send -----
  if (request.checkpoint === undefined) {
    const prepared = await prepare();
    if (prepared.kind === "wait") return pending(prepared.reason);
    if (prepared.kind === "too_small") {
      return { status: "too_small", reason: "too small after the fee budget and platform fee" };
    }
    if (prepared.kind === "stop") return { status: "failed", message: prepared.reason, transfers: [] };

    // Save the signed message before sending it, so a crash can't lose it.
    if (!(await request.saveCheckpoint(checkpointOf(prepared, request.destinationKind, platform)))) {
      return pending("another run saved this payout first");
    }
    if (await sendTonMessage(api, prepared.boc)) {
      console.log("TON payout sent:", depositAddress, prepared.hash);
    }
    return pending("sent; waiting for it to land");
  }

  // ----- saved: check, resend, or rebuild -----
  const saved = parseSavedTonTx(request.checkpoint.state);
  const deposit = parseTonAddress(depositAddress);
  const messageHash = saved
    ? Cell.fromBase64(saved.boc).hash().toString("hex")
    : undefined;

  if (saved === undefined || deposit === undefined || !messageHash) {
    return {
      status: "pending",
      reason: "no readable saved TON payout",
      review: `Invoice is processing but has no readable saved TON payout. The claim always saves it, so this is a bug or a manual DB edit. Funds may still be at deposit address ${depositAddress}; check an explorer before sending anything.`,
    };
  }

  // One snapshot: the wallet's seqno and the chain time it was taken at.
  const account = await getTonAccount(api, deposit);
  if (account === undefined) return pending("deposit account lookup failed");

  const seqno = readSeqno(account);
  if (seqno === undefined) return pending("deposit wallet seqno unreadable");

  if (seqno > saved.seqno) {
    // Our seqno was used: find that transaction and check what it paid.
    const transactions = await getRecentTonTransactions(api, deposit);
    if (transactions === undefined) return pending("deposit transactions lookup failed");

    const landed = findPayoutBySeqno(transactions, saved.seqno);
    if (landed === undefined) {
      console.warn("TON payout seqno was used, but its transaction is not in the recent list:", depositAddress);
      return pending("seqno used, but its transaction is not in the recent list");
    }

    // What the landed transaction really sent: the proof, or on failure the
    // record of where the money went.
    const receiverKind: Transfer["kind"] = request.destinationKind;
    const moved: Transfer[] = landed.sent
      .filter((m) => m.to.equals(saved.receiver) || m.to.equals(platform))
      .map((m) => ({
        kind: m.to.equals(saved.receiver) ? receiverKind : "platform_fee",
        to: m.to.toString({ bounceable: false }),
        amount: m.value,
        txid: landed.txHash,
      }));

    // Message 2 carries at most this when nothing went wrong: the platform
    // fee plus the fee budget, minus what the chain charged.
    const expectedToPlatform =
      request.checkpoint.plan.platformFee + request.checkpoint.plan.networkCost;

    if (
      landed.failed !== undefined ||
      !paidExactly(landed.sent, saved.receiver, saved.amount)
    ) {
      return {
        status: "failed",
        message: failedPayoutNote({
          txHash: landed.txHash,
          failed: landed.failed,
          sent: landed.sent,
          receiver: saved.receiver,
          amount: saved.amount,
          platform,
          expectedToPlatform,
          depositAddress,
          depositBalance: account.balance,
        }),
        transfers: moved,
      };
    }

    if (landed.messageHash !== messageHash) {
      // An earlier signed version landed with the same receiver and amount.
      console.warn("TON payout landed from an earlier signed version:", depositAddress, landed.messageHash);
    }

    // Late payment: money that reached the deposit after the payout was
    // signed rides along to the platform in message 2 (mode 128 sends
    // everything left). Without it, the platform message carries at most
    // platform fee + fee budget, minus what the chain charged.
    const toPlatform = landed.sent
      .filter((message) => message.to.equals(platform))
      .reduce((sum, message) => sum + message.value, 0n);
    const lateNote =
      toPlatform > expectedToPlatform
        ? `${LATE_PAYMENT_NOTE_PREFIX} at least ${toPlatform - expectedToPlatform} nanoton reached deposit address ${depositAddress} after the payout was signed and went to platform wallet ${platformAddress} in tx ${landed.txHash}. The merchant's payout was not affected. Forward the extra to the merchant.`
        : "";

    // The exact amount was sent non-bounceable, so the receiver has it (it
    // may take a few seconds to show).
    return { status: "paid", transfers: moved, ...(lateNote ? { note: lateNote } : {}) };
  }

  if (seqno < saved.seqno) {
    // Seqno never goes down unless the wallet was deleted and deployed
    // again. Something unusual happened: a person must look.
    console.error("TON deposit wallet seqno went down; needs review:", depositAddress);
    return {
      status: "pending",
      reason: "deposit wallet seqno went down",
      review: `TON deposit wallet seqno is ${seqno}, below the saved payout's ${saved.seqno}. Check deposit address ${depositAddress} on an explorer before sending anything.`,
    };
  }

  if (account.chainTime <= saved.validUntil + EXPIRY_MARGIN_SECONDS) {
    // Not landed yet, but it still can: send the same message again.
    await sendTonMessage(api, saved.boc);
    return pending(`message ${messageHash} not landed yet; sent again`);
  }

  // Expired without landing: the chain was past valid_until and the seqno
  // was still unused. A new message is safe now. It must reuse the same
  // seqno, so this and any old version can never both land.
  const prepared = await prepare();
  if (prepared.kind === "wait") return pending(prepared.reason);
  if (prepared.kind === "too_small") return pending("rebuild found the deposit too small");
  if (prepared.kind === "stop") return { status: "failed", message: prepared.reason, transfers: [] };
  if (prepared.seqno !== saved.seqno) {
    console.warn("TON rebuild saw a different seqno; waiting for the API to catch up:", depositAddress);
    return pending("rebuild saw a different seqno");
  }

  if (!(await request.saveCheckpoint(checkpointOf(prepared, request.destinationKind, platform)))) {
    return pending("another run rebuilt it first");
  }

  console.log("TON payout expired unsent; rebuilt:", depositAddress, messageHash, "->", prepared.hash);
  await sendTonMessage(api, prepared.boc);
  return pending("expired unsent; rebuilt and sent");
}
