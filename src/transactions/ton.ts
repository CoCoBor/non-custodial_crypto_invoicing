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
import { env } from "../config/env.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { ceilDivide } from "../money/format.js";
import { parseFeeRate, splitPayout } from "../money/payout-split.js";
import { acceptedPaymentAmount } from "../invoice/payment-rules.js";
import { openSecret, type SealedSecret } from "../security/secret-envelope.js";
import {
  isCryptoId,
  LATE_PAYMENT_NOTE_PREFIX,
  prepareSwap,
  swapFieldsToSave,
  type PreparedSwap,
} from "../swap/near.js";

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
const TON_PAYOUT_FEE = 5_000_000n;

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
const TX_LIFETIME_SECONDS = 300;
// Wait this much past valid_until before deciding a message can never land.
// A shard block from just before valid_until can reach the masterchain a few
// seconds later.
const EXPIRY_MARGIN_SECONDS = 60;
// A deposit wallet has few transactions (payments in, one payout out).
const RECENT_TX_LIMIT = 20;

// Merchant fee rates have 8 decimals: "0.005" = 0.5% = 500,000 / 10^8.
const FEE_RATE_DECIMALS = 8;
const FEE_RATE_SCALE = 10n ** BigInt(FEE_RATE_DECIMALS);

const STUCK_TX_REVIEW_MS = 24 * 60 * 60 * 1000;

// Amounts (nanoton) come as integer strings.
const u64String = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const accountStateSchema = z.enum(["active", "uninitialized", "frozen"]);
type AccountState = z.infer<typeof accountStateSchema>;

// ---------- Addresses ----------

// EQ…/UQ… form only: it has a checksum, so a typo is caught. Mainnet,
// workchain 0 (where all normal wallets live).
function parseTonAddress(value: string): Address | undefined {
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
function sameTonAccount(a: string, b: string): boolean {
  const x = parseTonAddress(a);
  const y = parseTonAddress(b);
  return x !== undefined && y !== undefined && x.equals(y);
}

// ---------- API (toncenter v2 format, served by NOWNodes) ----------

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

// One consistent snapshot of an account: balance, code, data, and the chain
// time of that snapshot. A never-used address answers "uninitialized" with
// balance 0. TON has no reorgs: once the API shows a state, it is final.
async function getTonAccount(address: Address) {
  const parsed = z
    .object({
      balance: u64String,
      state: accountStateSchema,
      code: z.string(),
      data: z.string(),
      sync_utime: z.number().int().positive(),
    })
    .safeParse(
      await callTonApi("getAddressInformation", {
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
async function getTonDestination(address: Address) {
  const parsed = z
    .object({ wallet: z.boolean(), account_state: accountStateSchema })
    .safeParse(
      await callTonApi("getWalletInformation", {
        query: { address: address.toString() },
      }),
    );
  if (!parsed.success) return undefined;
  return { isWallet: parsed.data.wallet, state: parsed.data.account_state };
}

// The newest transactions of an account, each as a base64 BOC.
async function getRecentTonTransactions(address: Address) {
  const parsed = z
    .array(z.object({ data: z.string().min(1) }))
    .safeParse(
      await callTonApi("getTransactions", {
        query: { address: address.toString(), limit: String(RECENT_TX_LIMIT) },
      }),
    );
  return parsed.success ? parsed.data.map((tx) => tx.data) : undefined;
}

// Sending the same signed message again is safe: its seqno can be used once.
async function sendTonMessage(boc: string): Promise<boolean> {
  return (await callTonApi("sendBoc", { body: { boc } })) !== undefined;
}

// ---------- Wallet ----------

type TonWallet = { contract: WalletContractV5R1; secretKey: Buffer };

// The key is the 24-word mnemonic (see crypto/ton.ts).
async function loadTonWallet(secret: string): Promise<TonWallet> {
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
function readSeqno(account: { state: AccountState; data?: Cell }) {
  if (account.state === "uninitialized") return 0;
  if (account.state !== "active" || !account.data) return undefined;
  return readW5Data(account.data)?.seqno;
}

// A deployed deposit wallet must run exactly our W5 code with our public
// key; anything else is a problem for a person.
function readDepositWallet(
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

// For the invoice watcher. Balance-based, like Solana: a deposit address only
// receives until the payout empties it. TON has no reorgs, so both numbers
// are the same.
// A payment sent "bounceable" to the new (code-less) deposit address goes
// back to the payer and never shows here; that is why the address is shown
// in its UQ… form.
export async function getTonPaymentTotals(
  depositAddress: string,
): Promise<{ receivedAmount: bigint; confirmedAmount: bigint } | undefined> {
  const address = parseTonAddress(depositAddress);
  if (address === undefined) return undefined;

  const account = await getTonAccount(address);
  if (account === undefined) return undefined;

  return { receivedAmount: account.balance, confirmedAmount: account.balance };
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
  if (split === undefined || split.merchantAmount <= 0n) return undefined;

  return { networkFee: TON_PAYOUT_FEE, ...split };
}

// ---------- Signing ----------

// Builds the external message: the signed W5 request, plus the wallet's code
// if it is not deployed yet. Its hash is known before sending, so it can be
// saved first.
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
  const { contract, secretKey } = input.wallet;
  const body = contract.createRequest({
    seqno: input.seqno,
    secretKey,
    timeout: input.validUntil,
    actions: [
      {
        type: "sendMsg",
        mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        outMsg: internal({
          to: input.receiver,
          value: input.amount,
          bounce: false,
        }),
      },
      {
        type: "sendMsg",
        mode: SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.IGNORE_ERRORS,
        outMsg: internal({
          to: input.platform,
          value: 0n,
          bounce: false,
        }),
      },
    ],
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

// ---------- Prepare one payout ----------

type PreparedPayout =
  | { kind: "wait" }
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
      swap: PreparedSwap | undefined;
    };

function notAWallet(address: string) {
  return `${address} is not a normal TON wallet (a common mistake is giving a USDT jetton wallet instead of the wallet address), so funds sent there could be locked`;
}

// Everything up to a signed message. Nothing is sent and nothing is saved.
// wait = temporary problem (retry next round), stop = permanent problem
// (needs a person). Problems with our own config throw.
async function prepareTonPayout(input: {
  invoiceId: string;
  depositAddress: string;
  merchantAddress: string;
  platformAddress: string;
  userId: string;
  feePaidByPayer: boolean;
  toCrypto: string;
  sealedDepositKey: SealedSecret | null | undefined;
  // The deposit must hold at least this much (the invoice amount).
  minimumTotal: bigint;
  // The invoice lifetime, for the storage-fee allowance.
  lifetimeMinutes: number;
}): Promise<PreparedPayout> {
  const { depositAddress, merchantAddress, platformAddress } = input;
  const fundsAt = `All funds are still at deposit address ${depositAddress}.`;

  function wait(why: string): PreparedPayout {
    console.warn(`TON payout waiting (${why}); will retry:`, input.invoiceId);
    return { kind: "wait" };
  }
  function stop(reason: string): PreparedPayout {
    return { kind: "stop", reason: `Payout stopped: ${reason}` };
  }

  if (input.feePaidByPayer) {
    return stop(`payer-paid fees are not supported for TON yet. ${fundsAt} Pay out manually.`);
  }

  const toCrypto = input.toCrypto;
  if (!isCryptoId(toCrypto)) {
    return stop(`payout asset "${toCrypto}" is unknown. ${fundsAt} Fix to_crypto, then pay out manually.`);
  }
  // Paid in TON but wanted in another coin: swap through NEAR.
  const swapTo = toCrypto === "ton" ? undefined : toCrypto;

  const deposit = parseTonAddress(depositAddress);
  if (deposit === undefined) {
    return stop(`deposit address "${depositAddress}" is not a valid TON address. Check how this invoice was created before moving any funds.`);
  }

  // Our own config, not the invoice: throw, never fail the invoice.
  const platform = parseTonAddress(platformAddress);
  if (platform === undefined) {
    throw new Error("Platform TON address is not a valid mainnet TON address");
  }

  // With a swap, the merchant address is on the other chain; NEAR checks
  // it when quoting.
  if (swapTo === undefined) {
    if (!isValidTonAddress(merchantAddress)) {
      return stop(`merchant payout address "${merchantAddress}" is not a valid mainnet TON address. ${fundsAt} Fix the merchant's TON address, then pay out manually.`);
    }
    if (sameTonAccount(merchantAddress, depositAddress)) {
      return stop(`merchant payout address is the deposit address itself. ${fundsAt} Fix the merchant's TON address, then pay out manually.`);
    }
  }

  const user = await User.findOne({ user_id: input.userId })
    .select("merchant_fee")
    .exec();
  if (!user) {
    return stop(`merchant account ${input.userId} was not found. ${fundsAt} Check whether the merchant was deleted, then pay out manually.`);
  }

  const feeRate = parseFeeRate(user.merchant_fee);
  if (feeRate === undefined) {
    return stop(`merchant fee rate "${user.merchant_fee}" is not a valid rate below 100%. ${fundsAt} Fix merchant_fee (e.g. "0.005" = 0.5%), then pay out manually.`);
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

  const platformAccount = await getTonDestination(platform);
  if (platformAccount === undefined) return wait("platform account lookup failed");
  if (
    platformAccount.state === "frozen" ||
    (platformAccount.state === "active" && !platformAccount.isWallet)
  ) {
    throw new Error("PLATFORM_TON_ADDRESS is not a normal TON wallet");
  }

  const account = await getTonAccount(deposit);
  if (account === undefined) return wait("deposit account lookup failed");

  const walletState = readDepositWallet(account, wallet.contract);
  if ("problem" in walletState) {
    return stop(`${walletState.problem}. ${fundsAt} Investigate before moving anything.`);
  }

  if (account.balance < tonMinimumPayment(input.minimumTotal, input.lifetimeMinutes)) {
    return wait("the deposit holds less than expected");
  }

  const plan = planTonPayout(account.balance, feeRate);
  if (plan === undefined) return wait("too small after the fee budget and platform fee");

  // Who receives: the merchant, or NEAR's deposit address for a swap.
  let receiverText = merchantAddress;
  let swap: PreparedSwap | undefined;
  if (swapTo !== undefined) {
    swap = await prepareSwap(
      {
        crypto: "ton",
        isValidAddress: isValidTonAddress,
        // The same for every address on TON: the fee budget is fixed.
        amountArrivingAt: async () => plan.merchantAmount,
        // NEAR refunds go to the platform wallet; the admin pays the
        // merchant from there.
        refundAddress: platformAddress,
        platformAddress,
      },
      swapTo,
      merchantAddress,
    );
    if (swap === undefined) return wait("swap quote not ready");
    // prepareSwap compares strings; one account has two forms, so check again.
    if (
      sameTonAccount(swap.depositAddress, platformAddress) ||
      sameTonAccount(swap.depositAddress, depositAddress)
    ) {
      return wait("NEAR's deposit address is one of ours");
    }
    receiverText = swap.depositAddress;
  }

  const receiver = parseTonAddress(receiverText);
  if (receiver === undefined) throw new Error("receiver address was checked above");

  const destination = await getTonDestination(receiver);
  if (destination === undefined) return wait("receiver account lookup failed");
  const problem =
    destination.state === "frozen"
      ? `${receiverText} is frozen, so it can't receive`
      : destination.state === "active" && !destination.isWallet
        ? notAWallet(receiverText)
        : undefined;
  if (problem !== undefined) {
    return swap
      ? wait(`NEAR's deposit address can't receive: ${problem}`)
      : stop(`the merchant can't receive TON: ${problem}. ${fundsAt} Ask the merchant for another wallet address, then pay out manually.`);
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
      swap,
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

function savedTxFields(prepared: Extract<PreparedPayout, { kind: "ready" }>) {
  return {
    "tx.out": prepared.hash,
    "tx.raw": JSON.stringify({
      boc: prepared.boc,
      seqno: prepared.seqno,
      validUntil: prepared.validUntil,
      receiver: prepared.receiver,
      amount: prepared.merchantAmount.toString(),
    }),
    // Swap: what the merchant gets is known only when NEAR finishes
    // (updateSwapStatus sets it).
    received_amount: prepared.swap ? "0" : prepared.merchantAmount.toString(),
    network_fee: prepared.networkFee.toString(),
    platform_fee: prepared.platformFee.toString(),
    ...(prepared.swap ? swapFieldsToSave(prepared.swap) : {}),
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
    for (const out of tx.outMessages.values()) {
      if (out.info.type === "internal") {
        sent.push({
          to: out.info.dest,
          value: out.info.value.coins,
          bounce: out.info.bounce,
        });
      }
    }

    const d = tx.description;
    let failed: string | undefined;
    if (d.type !== "generic") failed = `unexpected transaction type ${d.type}`;
    else if (d.aborted) failed = "the transaction was aborted";
    else if (d.computePhase.type !== "vm" || !d.computePhase.success) {
      failed = "the wallet code did not run successfully";
    } else if (d.actionPhase && !d.actionPhase.success) failed = "the send step failed";

    return { txHash: root.hash().toString("hex"), messageHash, sent, failed };
  }
  return undefined;
}

type SentMessage = { to: Address; value: bigint; bounce: boolean };

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

export async function transferTonToMerchant(
  invoiceId: string,
  platformAddress: string,
) {
  try {
    const invoice = await Invoice.findOne({
      invoice_id: invoiceId,
      crypto: "ton",
      status: { $in: ["confirmed", "processing"] },
    })
      .select("+private.private_key +tx.raw")
      .exec();
    if (!invoice) return;

    if (!isValidTonAddress(platformAddress)) {
      throw new Error("Platform TON address is not a valid mainnet TON address");
    }

    async function markFailed(
      fromStatus: "confirmed" | "processing",
      reason: string,
    ) {
      const result = await Invoice.updateOne(
        { invoice_id: invoiceId, crypto: "ton", status: fromStatus },
        {
          $set: {
            status: "failed",
            "timestamps.failed": Date.now(),
            review_reason: reason,
          },
        },
      ).exec();

      if (result.matchedCount === 0) {
        console.warn(
          `TON payout: could not mark failed, invoice is no longer ${fromStatus}:`,
          invoiceId,
          reason,
        );
        return;
      }
      console.error("TON payout failed:", invoiceId, reason);
    }

    const isSwap = invoice.to_crypto !== "ton";

    // The deposit must still hold the invoice amount (minus the small
    // storage-fee allowance, see tonMinimumPayment). On a rebuild, less
    // means the old message probably landed and this API node can't see it.
    const prepare = () =>
      prepareTonPayout({
        invoiceId,
        depositAddress: invoice.address,
        merchantAddress: invoice.to_address,
        platformAddress,
        userId: invoice.user_id,
        feePaidByPayer: invoice.fee_paid_by_payer,
        toCrypto: invoice.to_crypto,
        sealedDepositKey: invoice.private?.private_key,
        // The same minimum the watcher confirmed at, tolerance included.
        minimumTotal: acceptedPaymentAmount(invoice),
        lifetimeMinutes: invoice.lifetime,
      });

    // ----- confirmed: sign, save, then send -----
    if (invoice.status === "confirmed") {
      const prepared = await prepare();
      if (prepared.kind === "wait") return;
      if (prepared.kind === "stop") {
        return await markFailed("confirmed", prepared.reason);
      }

      // Save the signed message before sending it, so a crash can't lose it.
      const claimed = await Invoice.findOneAndUpdate(
        { invoice_id: invoiceId, crypto: "ton", status: "confirmed" },
        {
          $set: {
            status: "processing",
            "timestamps.processing": Date.now(),
            ...savedTxFields(prepared),
          },
        },
        { returnDocument: "after" },
      ).exec();

      if (claimed === null) {
        console.warn("Another run claimed it first", invoiceId);
        return;
      }

      if (await sendTonMessage(prepared.boc)) {
        console.log("TON payout sent:", invoiceId, prepared.hash);
      }
      return;
    }

    // ----- processing: check, resend, or rebuild -----
    // Until the payout lands, tx.out holds the external message hash (all we
    // know before sending). Once it lands, tx.out holds the transaction hash,
    // like the other coins, and the message hash stays derivable from the
    // saved message in tx.raw.
    const txOut = invoice.tx?.out;
    const saved = parseSavedTonTx(invoice.tx?.raw);
    const deposit = parseTonAddress(invoice.address);
    const messageHash = saved
      ? Cell.fromBase64(saved.boc).hash().toString("hex")
      : undefined;

    if (!txOut || saved === undefined || deposit === undefined || !messageHash) {
      await Invoice.updateOne(
        { invoice_id: invoiceId, crypto: "ton", status: "processing" },
        {
          $set: {
            review_reason: `Invoice is processing but has no readable saved TON payout. The claim always saves it, so this is a bug or a manual DB edit. Funds may still be at deposit address ${invoice.address}; check an explorer before sending anything.`,
          },
        },
      ).exec();
      console.error("TON invoice is processing but has no saved payout; needs review:", invoiceId);
      return;
    }

    if (txOut !== messageHash) {
      // The landing is already recorded (tx.out is the transaction hash).
      // Only a swap stays processing after that: NEAR's status completes it
      // (updateSwapStatus in swap/near.ts).
      return;
    }

    const noteIfStuck = async () => {
      const processingAt = invoice.timestamps?.processing;
      if (processingAt == null || Date.now() - processingAt < STUCK_TX_REVIEW_MS) {
        return;
      }

      const reason = `TON payout has not landed after 24 hours (latest message ${messageHash}). Funds stay at deposit address ${invoice.address} until a payout lands. Expired messages are rebuilt automatically; check the logs (API errors). Do not pay the merchant from another wallet: the automatic payout can still land.`;

      const result = await Invoice.updateOne(
        {
          invoice_id: invoiceId,
          crypto: "ton",
          status: "processing",
          review_reason: { $ne: reason },
        },
        { $set: { review_reason: reason } },
      ).exec();

      if (result.modifiedCount === 1) {
        console.error("TON payout stuck; needs review:", invoiceId, messageHash);
      }
    };

    // One snapshot: the wallet's seqno and the chain time it was taken at.
    const account = await getTonAccount(deposit);
    if (account === undefined) return await noteIfStuck();

    const seqno = readSeqno(account);
    if (seqno === undefined) return await noteIfStuck();

    if (seqno > saved.seqno) {
      // Our seqno was used: find that transaction and check what it paid.
      const transactions = await getRecentTonTransactions(deposit);
      if (transactions === undefined) return await noteIfStuck();

      const landed = findPayoutBySeqno(transactions, saved.seqno);
      if (landed === undefined) {
        console.warn("TON payout seqno was used, but its transaction is not in the recent list:", invoiceId);
        return await noteIfStuck();
      }

      const platform = parseTonAddress(platformAddress);
      if (platform === undefined) {
        throw new Error("Platform TON address is not a valid mainnet TON address");
      }
      // Message 2 carries at most this when nothing went wrong: the platform
      // fee plus the fee budget, minus what the chain charged.
      const expectedToPlatform =
        BigInt(invoice.platform_fee) + BigInt(invoice.network_fee);

      if (
        landed.failed !== undefined ||
        !paidExactly(landed.sent, saved.receiver, saved.amount)
      ) {
        return await markFailed(
          "processing",
          failedPayoutNote({
            txHash: landed.txHash,
            failed: landed.failed,
            sent: landed.sent,
            receiver: saved.receiver,
            amount: saved.amount,
            platform,
            expectedToPlatform,
            depositAddress: invoice.address,
            depositBalance: account.balance,
          }),
        );
      }

      if (landed.messageHash !== messageHash) {
        // An earlier signed version landed with the same receiver and amount.
        console.warn("TON payout landed from an earlier signed version:", invoiceId, landed.messageHash);
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
          ? `${LATE_PAYMENT_NOTE_PREFIX} at least ${toPlatform - expectedToPlatform} nanoton reached deposit address ${invoice.address} after the payout was signed and went to platform wallet ${platformAddress} in tx ${landed.txHash}. The merchant's payout was not affected. Forward the extra to the merchant.`
          : "";

      // A normal payout is done: the exact amount was sent non-bounceable, so
      // the merchant has it (it may take a few seconds to show). A swap stays
      // processing: the coins reached NEAR, and NEAR's status completes the
      // invoice (updateSwapStatus in swap/near.ts).
      const result = await Invoice.updateOne(
        { invoice_id: invoiceId, crypto: "ton", status: "processing", "tx.out": messageHash },
        {
          $set: {
            "tx.out": landed.txHash,
            review_reason: lateNote,
            ...(isSwap
              ? {}
              : { status: "completed", "timestamps.completed": Date.now() }),
          },
        },
      ).exec();

      if (result.modifiedCount > 0) {
        console.log(isSwap ? "TON swap payout reached NEAR:" : "TON payout completed:", invoiceId, landed.txHash);
        if (lateNote) console.warn("TON late payment went to the platform; needs review:", invoiceId);
      }
      return;
    }

    if (seqno < saved.seqno) {
      // Seqno never goes down unless the wallet was deleted and deployed
      // again. Something unusual happened: a person must look.
      await Invoice.updateOne(
        { invoice_id: invoiceId, crypto: "ton", status: "processing" },
        {
          $set: {
            review_reason: `TON deposit wallet seqno is ${seqno}, below the saved payout's ${saved.seqno}. Check deposit address ${invoice.address} on an explorer before sending anything.`,
          },
        },
      ).exec();
      console.error("TON deposit wallet seqno went down; needs review:", invoiceId);
      return;
    }

    if (account.chainTime <= saved.validUntil + EXPIRY_MARGIN_SECONDS) {
      // Not landed yet, but it still can: send the same message again.
      await sendTonMessage(saved.boc);
      return await noteIfStuck();
    }

    // Expired without landing: the chain was past valid_until and the seqno
    // was still unused. A new message is safe now. It must reuse the same
    // seqno, so this and any old version can never both land.
    // A swap also gets a fresh NEAR quote: nothing reached the old one.
    const prepared = await prepare();
    if (prepared.kind === "wait") return await noteIfStuck();
    if (prepared.kind === "stop") {
      return await markFailed("processing", prepared.reason);
    }
    if (prepared.seqno !== saved.seqno) {
      console.warn("TON rebuild saw a different seqno; waiting for the API to catch up:", invoiceId);
      return await noteIfStuck();
    }

    const result = await Invoice.updateOne(
      { invoice_id: invoiceId, crypto: "ton", status: "processing", "tx.out": messageHash },
      { $set: savedTxFields(prepared) },
    ).exec();

    if (result.modifiedCount === 0) {
      console.warn("Another run rebuilt it first", invoiceId);
      return;
    }

    console.log("TON payout expired unsent; rebuilt:", invoiceId, messageHash, "->", prepared.hash);
    await sendTonMessage(prepared.boc);
  } catch (error) {
    console.error(
      "TON payout could not finish; invoice state was preserved:",
      invoiceId,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}
