import {
  address as toSolAddress,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  blockhash as toBlockhash,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { z } from "zod";

import type { AssetId } from "../assets/payout-address.js";
import type { PayoutCheckpoint, PayoutRequest, PayoutResult, Transfer } from "../chains/adapter.js";
import type { SolanaRpc } from "../chains/solana-rpc.js";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "../money/format.js";
import { splitPayout } from "../money/payout-split.js";
import { openSecret, type SealedSecret } from "../security/secret-envelope.js";
import type { PricePort } from "./evm.js";

// Payouts from a Solana deposit, in SOL or in an SPL token (USDT, USDC).
// @solana/kit only builds and signs; every network call goes through the
// injected SolanaRpc.
//
// SOL: one transaction from the deposit, which pays its own fee and ends at
// exactly 0 lamports.
//
// A token: one transaction, signed by the gas wallet as fee payer and by the
// deposit as the tokens' owner. The gas wallet pays the fee and the rent of
// any token account the payout creates. There is no separate top-up
// transaction (as on EVM): the deposit never needs SOL of its own. What the
// gas wallet spends is converted to token units at the current prices and
// taken from the merchant's share; it rides on the platform's token transfer.

export type SplToken = { asset: AssetId; mint: string; decimals: number };

export type SolPayoutDeps = {
  rpc: SolanaRpc;
  /** Our own config: a missing one makes the payout wait with a review note. */
  platformAddress: string | undefined;
};

export type SplPayoutDeps = SolPayoutDeps & {
  token: SplToken;
  gasWalletKey: SealedSecret | undefined;
  getPrice: PricePort;
};

export function isValidSolAddress(value: string): boolean {
  return isAddress(value);
}

// Size of an SPL token account. Its rent is what creating one costs.
const TOKEN_ACCOUNT_SIZE = 165;

// Fee = 5,000 lamports per signature + priority fee. Priority fee = price
// (micro-lamports per compute unit) × the compute unit LIMIT asked for,
// rounded up: the limit is charged even if the transaction uses less.
const LAMPORTS_PER_SIGNATURE = 5_000n;
const MICROLAMPORTS_PER_LAMPORT = 1_000_000n;
// 2 compute-budget + up to 2 SOL transfers. Mainnet simulation on 2026-11-09 used 600.
const SOL_PAYOUT_COMPUTE_UNITS = 1_500;
// 2 compute-budget + up to 2 create-if-missing + 2 token transfers.
// Mainnet simulation on 2026-11-09: 30,664 with both accounts created and a close.
const TOKEN_PAYOUT_COMPUTE_UNITS = 100_000;

// Priority fee price, micro-lamports per compute unit. Most blocks accept 0,
// so the floor is what we pay on a normal day; the estimate only wins when
// the network is busy. The cap stops a broken estimate from overpaying.
const MIN_PRIORITY_FEE = 50_000n;
const MAX_PRIORITY_FEE = 2_000_000n;

const SOL_ASSET: AssetId = "sol";
const SOL_DECIMALS = 9;
const PRICE_DECIMALS = 10;

// Base58 text: 32-byte addresses/blockhashes are 32–44 chars, 64-byte signatures 64–88.
const base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const base58Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
// Solana sends u64 values (lamports, slots, heights) as JSON numbers; above
// 2^53 a JS number silently loses digits, and zod 4's int() rejects those.
const u64Number = z.number().int().nonnegative();
const u64String = z.string().regex(/^(?:0|[1-9][0-9]*)$/);

// confirmed = voted on by a supermajority, very unlikely to roll back.
// finalized = cannot roll back. Money is decided on finalized.
type Commitment = "confirmed" | "finalized";

// ---------- JSON-RPC reads ----------

async function lamportsOf(rpc: SolanaRpc, owner: string, commitment: Commitment): Promise<bigint | undefined> {
  const parsed = z.object({ value: u64Number }).safeParse(await rpc.call("getBalance", [owner, { commitment }]));
  return parsed.success ? BigInt(parsed.data.value) : undefined;
}

type WalletCheck = { lamports: bigint } | "not-a-wallet";

/**
 * A payout address must be a normal wallet: no account yet, or one the System
 * Program owns. A token account or a program's account would take the money,
 * and nobody could move it out. undefined: the lookup failed.
 */
async function checkWallet(rpc: SolanaRpc, owner: string): Promise<WalletCheck | undefined> {
  const parsed = z
    .object({ value: z.object({ owner: base58Address, lamports: u64Number, executable: z.boolean() }).nullable() })
    .safeParse(
      await rpc.call("getAccountInfo", [
        owner,
        { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } },
      ]),
    );
  if (!parsed.success) return undefined;
  const info = parsed.data.value;
  if (info === null) return { lamports: 0n };
  if (info.owner !== SYSTEM_PROGRAM_ADDRESS || info.executable) return "not-a-wallet";
  return { lamports: BigInt(info.lamports) };
}

type TokenAccount = { amount: bigint; frozen: boolean };

/**
 * The token account at `account`. null: there is none. `problem`: something
 * that is not `owner`'s account for this mint sits there. undefined: the
 * lookup failed.
 */
async function tokenAccountAt(
  rpc: SolanaRpc,
  account: string,
  owner: string,
  token: SplToken,
  commitment: Commitment,
): Promise<TokenAccount | null | { problem: string } | undefined> {
  const reply = await rpc.call("getAccountInfo", [account, { commitment, encoding: "jsonParsed" }]);
  const envelope = z.object({ value: z.object({ owner: base58Address, data: z.unknown() }).nullable() }).safeParse(reply);
  if (!envelope.success) return undefined;
  if (envelope.data.value === null) return null;
  const data = z
    .object({
      program: z.literal("spl-token"),
      parsed: z.object({
        type: z.literal("account"),
        info: z.object({
          mint: base58Address,
          owner: base58Address,
          state: z.enum(["uninitialized", "initialized", "frozen"]),
          tokenAmount: z.object({ amount: u64String, decimals: z.number().int().nonnegative() }),
        }),
      }),
    })
    .safeParse(envelope.data.value.data);
  if (envelope.data.value.owner !== TOKEN_PROGRAM_ADDRESS || !data.success) {
    return { problem: `${account} is not a ${token.asset} token account` };
  }
  const info = data.data.parsed.info;
  if (info.mint !== token.mint || info.owner !== owner) {
    return { problem: `${account} is not ${owner}'s ${token.asset} account` };
  }
  if (info.tokenAmount.decimals !== token.decimals) {
    return { problem: `${account} reports ${info.tokenAmount.decimals} decimals, not ${token.decimals}` };
  }
  if (info.state === "uninitialized") return { problem: `${account} is not initialized` };
  return { amount: BigInt(info.tokenAmount.amount), frozen: info.state === "frozen" };
}

/** A wallet holds a token in its associated token account: wallets and exchanges send there. */
export async function associatedTokenAccount(owner: string, mint: string): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner: toSolAddress(owner),
    mint: toSolAddress(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

async function rentExemption(rpc: SolanaRpc, space: number): Promise<bigint | undefined> {
  const parsed = u64Number.safeParse(await rpc.call("getMinimumBalanceForRentExemption", [space]));
  return parsed.success ? BigInt(parsed.data) : undefined;
}

/** The 75th percentile of recent priority fee prices, within the floor and the cap. */
async function priorityFeePrice(rpc: SolanaRpc): Promise<bigint | undefined> {
  const parsed = z
    .array(z.object({ slot: u64Number, prioritizationFee: u64Number }))
    .safeParse(await rpc.call("getRecentPrioritizationFees", []));
  if (!parsed.success) return undefined;
  const prices = parsed.data.map((block) => BigInt(block.prioritizationFee)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const p75 = prices.length > 0 ? prices[Math.floor((prices.length - 1) * 0.75)]! : 0n;
  if (p75 < MIN_PRIORITY_FEE) return MIN_PRIORITY_FEE;
  if (p75 > MAX_PRIORITY_FEE) return MAX_PRIORITY_FEE;
  return p75;
}

// A transaction can land only while the block height is at most lastValidBlockHeight.
async function latestBlockhash(rpc: SolanaRpc) {
  const parsed = z
    .object({ value: z.object({ blockhash: base58Address, lastValidBlockHeight: u64Number }) })
    .safeParse(await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]));
  return parsed.success ? parsed.data.value : undefined;
}

async function finalizedBlockHeight(rpc: SolanaRpc): Promise<bigint | undefined> {
  const parsed = u64Number.safeParse(await rpc.call("getBlockHeight", [{ commitment: "finalized" }]));
  return parsed.success ? BigInt(parsed.data) : undefined;
}

/**
 * undefined: the lookup failed. null: not found (not landed yet, or expired).
 * err set: it landed and failed: the fee was paid, nothing else happened.
 */
async function signatureStatus(rpc: SolanaRpc, signature: string) {
  const parsed = z
    .object({
      value: z.tuple([
        z
          .object({
            err: z.unknown(),
            confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).nullable(),
          })
          .nullable(),
      ]),
    })
    .safeParse(
      await rpc.call("getSignatureStatuses", [
        [signature],
        // Also look past the recent cache, so an old transaction is found, not "null".
        { searchTransactionHistory: true },
      ]),
    );
  if (!parsed.success) return undefined;
  const status = parsed.data.value[0];
  return status === null ? null : { err: status.err ?? null, finalized: status.confirmationStatus === "finalized" };
}

async function broadcast(rpc: SolanaRpc, state: SavedTx): Promise<void> {
  // Preflight stays on: a transaction that would fail is refused before it
  // costs a fee. The same signed bytes can land at most once.
  const sent = base58Signature.safeParse(
    await rpc.call("sendTransaction", [state.wire, { encoding: "base64", preflightCommitment: "confirmed" }]),
  );
  if (sent.success && sent.data === state.signature) console.log("SOL payout transaction broadcast:", state.signature);
  // A refused send is already logged by the RPC client; the status decides next round.
}

const instructionSchema = z.object({
  program: z.string().optional(),
  programId: base58Address,
  parsed: z.unknown().optional(),
});

const parsedTransactionSchema = z.object({
  meta: z.object({
    err: z.unknown(),
    preBalances: z.array(u64Number),
    postBalances: z.array(u64Number),
  }),
  transaction: z.object({
    message: z.object({
      accountKeys: z.array(z.object({ pubkey: base58Address })),
      instructions: z.array(instructionSchema),
    }),
  }),
});
type ParsedTransaction = z.infer<typeof parsedTransactionSchema>;

/** A finalized transaction with parsed instructions. undefined: unavailable now. */
async function finalizedTransaction(rpc: SolanaRpc, signature: string): Promise<ParsedTransaction | undefined> {
  const parsed = parsedTransactionSchema.safeParse(
    await rpc.call("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
    ]),
  );
  return parsed.success ? parsed.data : undefined;
}

// ---------- Signing ----------

type Lifetime = { blockhash: string; lastValidBlockHeight: number };

async function signTransaction(feePayer: KeyPairSigner, instructions: Instruction[], lifetime: Lifetime) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  // Signers come from the fee payer and the instructions' accounts.
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithinSizeLimit(signed);
  return { signature: getSignatureFromTransaction(signed) as string, wire: getBase64EncodedWireTransaction(signed) as string };
}

function computeBudget(units: number, price: bigint): Instruction[] {
  return [getSetComputeUnitLimitInstruction({ units }), getSetComputeUnitPriceInstruction({ microLamports: price })];
}

function networkFee(signatures: bigint, computeUnits: number, price: bigint): bigint {
  return LAMPORTS_PER_SIGNATURE * signatures + ceilDivide(BigInt(computeUnits) * price, MICROLAMPORTS_PER_LAMPORT);
}

/** The key text is base58 of 64 bytes (src/crypto/sol.ts). Kit checks both halves match. */
async function loadSigner(secret: string): Promise<KeyPairSigner> {
  return await createKeyPairSignerFromBytes(getBase58Encoder().encode(secret));
}

// ---------- Checkpoint state ----------

const plannedTransferSchema = z.object({
  kind: z.enum(["gas_top_up", "merchant_payout", "platform_fee", "refund_route", "swap_deposit"]),
  to: base58Address,
  amount: u64String,
});

const savedTxSchema = z.object({
  v: z.literal(1),
  mode: z.enum(["native", "token"]),
  signature: base58Signature,
  wire: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  // The transaction can never land once the finalized block height is above this.
  lastValidBlockHeight: u64String,
  // Token payouts: the gas wallet that signed as fee payer.
  feePayer: base58Address.optional(),
  transfers: z.array(plannedTransferSchema).min(1),
});
type SavedTx = z.infer<typeof savedTxSchema>;

function readState(text: string): SavedTx | undefined {
  try {
    const parsed = savedTxSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function checkpointOf(state: SavedTx, platformFee: bigint, networkCost: bigint): PayoutCheckpoint {
  return {
    state: JSON.stringify(state),
    plan: {
      transfers: state.transfers.map((t) => ({ kind: t.kind, to: t.to, amount: BigInt(t.amount), txid: state.signature })),
      platformFee,
      networkCost,
    },
  };
}

function unreadable(depositAddress: string): PayoutResult {
  return {
    status: "pending",
    reason: "unreadable saved SOL payout",
    review: `The saved Solana payout is unreadable. Funds may still be at deposit address ${depositAddress}; check a block explorer before sending anything.`,
  };
}

// ---------- Shared checks ----------

const nothingSent = (depositAddress: string, what = "funds") =>
  `Nothing was sent: all ${what} are still at deposit address ${depositAddress}.`;

function stopped(depositAddress: string, reason: string, what?: string): PayoutResult {
  return {
    status: "failed",
    message: `Solana payout stopped: ${reason}. ${nothingSent(depositAddress, what)} Fix the cause, then set the invoice back to "confirmed" to retry, or move the funds by hand with the deposit key.`,
    transfers: [],
  };
}

const NOT_A_WALLET =
  "is not a normal Solana wallet (a program owns it; a common mistake is giving a token account instead of the wallet address), so funds sent there could be locked";

/** Checks shared by both payouts. A PayoutResult ends the payout there. */
async function prepare(
  request: PayoutRequest,
  deps: SolPayoutDeps,
  ownAsset: AssetId,
  what?: string,
): Promise<{ deposit: KeyPairSigner; platformAddress: string } | PayoutResult> {
  const { depositAddress, destination } = request;
  const platformAddress = deps.platformAddress;
  if (platformAddress === undefined || !isAddress(platformAddress)) {
    return {
      status: "pending",
      reason: "platform SOL address is not configured",
      review: `The platform Solana address is not configured, so this payout waits. ${nothingSent(depositAddress, what)} Set PLATFORM_SOL_ADDRESS in the server config.`,
    };
  }
  if (request.receiveAsset !== ownAsset) return stopped(depositAddress, `a ${ownAsset} deposit can't be paid out as ${request.receiveAsset}`, what);
  if (!isAddress(destination)) return stopped(depositAddress, `destination "${destination}" is not a valid Solana address`, what);
  if (destination === depositAddress) return stopped(depositAddress, "the destination is the deposit address itself", what);
  if (request.depositKey.kind !== "sealed_key") return stopped(depositAddress, "the deposit private key is missing", what);

  let deposit: KeyPairSigner;
  try {
    deposit = await loadSigner(openSecret("solana-deposit-key", request.depositKey.sealed));
  } catch {
    return stopped(depositAddress, "the stored deposit key can't be opened", what);
  }
  if (deposit.address !== depositAddress) {
    return stopped(depositAddress, `the stored key opens ${deposit.address}, not the deposit address. Do not retry; investigate the key storage`, what);
  }
  return { deposit, platformAddress };
}

/**
 * Follows a saved payout: re-sends the same signed bytes while they can still
 * land, rebuilds once they provably never can, and proves a finalized one.
 */
async function follow(
  request: PayoutRequest,
  rpc: SolanaRpc,
  state: SavedTx,
  rebuild: () => Promise<PayoutResult>,
  prove: (tx: ParsedTransaction, planned: SavedTx["transfers"][number]) => Promise<bigint | undefined>,
): Promise<PayoutResult> {
  const { depositAddress } = request;
  // Read the finalized height BEFORE the status: if it is already past
  // lastValidBlockHeight and the status still finds nothing, it never landed.
  const height = await finalizedBlockHeight(rpc);
  if (height === undefined) return { status: "pending", reason: "SOL block height unavailable" };
  const status = await signatureStatus(rpc, state.signature);
  if (status === undefined) return { status: "pending", reason: "SOL signature status unavailable" };

  if (status === null) {
    if (height > BigInt(state.lastValidBlockHeight)) {
      const rebuilt = await rebuild();
      if (rebuilt.status !== "too_small") return rebuilt;
      // The plan was saved before, so the watcher treats this payout as in flight.
      return {
        status: "pending",
        reason: rebuilt.reason,
        review: `Solana payout ${state.signature} expired without landing, and a new one is now too small to forward (${rebuilt.reason}). Nothing was sent: the funds are still at deposit address ${depositAddress}.`,
      };
    }
    await broadcast(rpc, state);
    return { status: "pending", reason: "sent; waiting for it to land" };
  }

  if (status.err !== null) {
    const error = JSON.stringify(status.err).slice(0, 200);
    return {
      status: "failed",
      message: `Solana payout transaction ${state.signature} failed on chain (${error}): its fee was paid, but nothing moved. The rest is still at deposit address ${depositAddress}. Find out why it was refused, then set the invoice back to "confirmed" to retry, or pay out by hand with the deposit key.`,
      transfers: [],
    };
  }
  if (!status.finalized) return { status: "pending", reason: "landed; waiting until it is finalized" };

  const tx = await finalizedTransaction(rpc, state.signature);
  if (tx === undefined) return { status: "pending", reason: "SOL transaction lookup failed" };

  const moved: Transfer[] = [];
  const notes: string[] = [];
  for (const planned of state.transfers) {
    const amount = await prove(tx, planned);
    if (amount === undefined) return { status: "pending", reason: "SOL transaction lookup failed" };
    moved.push({ kind: planned.kind, to: planned.to, amount, txid: state.signature });
    if (planned.kind === "gas_top_up" || amount === BigInt(planned.amount)) continue;
    if (planned.kind === "platform_fee") {
      notes.push(`Platform transfer in ${state.signature} delivered ${amount}, not the planned ${planned.amount}.`);
      continue;
    }
    return {
      status: "failed",
      message: `Solana payout ${state.signature} to ${planned.to} landed but delivered ${amount}, not the planned ${planned.amount}. Anything not delivered is still at deposit address ${depositAddress}. Check the transaction on a block explorer, then settle the difference by hand.`,
      transfers: moved,
    };
  }
  return { status: "paid", transfers: moved, ...(notes.length > 0 && { note: notes.join(" ") }) };
}

async function saveAndSend(
  request: PayoutRequest,
  rpc: SolanaRpc,
  state: SavedTx,
  platformFee: bigint,
  networkCost: bigint,
): Promise<PayoutResult> {
  if (!(await request.saveCheckpoint(checkpointOf(state, platformFee, networkCost)))) {
    return { status: "pending", reason: "another run saved this payout first" };
  }
  await broadcast(rpc, state);
  return { status: "pending", reason: "broadcast; waiting until it is finalized" };
}

// ---------- SOL ----------

/**
 * The F1 split of a SOL deposit, which ends at exactly 0. Solana rule: after
 * a transaction every account holds 0 or at least the rent minimum. So a
 * platform fee too small to open an empty platform wallet goes to the
 * merchant, and a merchant share too small to open theirs is too small to
 * forward (undefined).
 */
function planSol(input: {
  total: bigint;
  priorityFee: bigint;
  feeRate: bigint;
  platformLamports: bigint;
  destinationLamports: bigint;
  rentMinimum: bigint;
}) {
  const cost = networkFee(1n, SOL_PAYOUT_COMPUTE_UNITS, input.priorityFee);
  const split = splitPayout({ received: input.total, networkCost: cost, feeRate: input.feeRate });
  if (split === undefined) return undefined;
  let { platformFee, merchantAmount } = split;
  if (platformFee > 0n && input.platformLamports + platformFee < input.rentMinimum) {
    merchantAmount += platformFee;
    platformFee = 0n;
  }
  if (input.destinationLamports + merchantAmount < input.rentMinimum) return undefined;
  return { networkCost: cost, platformFee, merchantAmount };
}

export async function estimateSolNetworkCost(rpc: SolanaRpc): Promise<bigint | undefined> {
  const price = await priorityFeePrice(rpc);
  return price === undefined ? undefined : networkFee(1n, SOL_PAYOUT_COMPUTE_UNITS, price);
}

const solTransferProof = (depositAddress: string) => async (tx: ParsedTransaction, planned: SavedTx["transfers"][number]) => {
  let lamports = 0n;
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId !== SYSTEM_PROGRAM_ADDRESS) continue;
    const parsed = z
      .object({ type: z.literal("transfer"), info: z.object({ source: z.string(), destination: z.string(), lamports: u64Number }) })
      .safeParse(ix.parsed);
    if (parsed.success && parsed.data.info.source === depositAddress && parsed.data.info.destination === planned.to) {
      lamports += BigInt(parsed.data.info.lamports);
    }
  }
  return lamports;
};

/** The SOL side of ChainAdapter.payout (src/chains/adapter.ts). Never touches the database. */
export async function payOutSol(request: PayoutRequest, deps: SolPayoutDeps): Promise<PayoutResult> {
  if (request.checkpoint !== undefined) {
    const state = readState(request.checkpoint.state);
    if (state?.mode !== "native") return unreadable(request.depositAddress);
    return await follow(request, deps.rpc, state, () => startSol(request, deps), solTransferProof(request.depositAddress));
  }
  return await startSol(request, deps);
}

async function startSol(request: PayoutRequest, deps: SolPayoutDeps): Promise<PayoutResult> {
  const { rpc } = deps;
  const { depositAddress, destination, destinationKind } = request;

  const prepared = await prepare(request, deps, SOL_ASSET);
  if (!("deposit" in prepared)) return prepared;
  const { deposit, platformAddress } = prepared;

  const [total, seen] = await Promise.all([lamportsOf(rpc, depositAddress, "finalized"), lamportsOf(rpc, depositAddress, "confirmed")]);
  if (total === undefined || seen === undefined) return { status: "pending", reason: "deposit balance unavailable" };
  // The transaction must empty the deposit exactly: a payment still arriving
  // would leave a remainder, which may be below the rent minimum.
  if (seen !== total) return { status: "pending", reason: "a payment to the deposit is not finalized yet" };
  if (total < request.minimumAmount || total === 0n) return { status: "pending", reason: "the deposit holds less than the payout minimum" };

  const [receiver, platformWallet, rentMinimum, priorityFee] = await Promise.all([
    checkWallet(rpc, destination),
    checkWallet(rpc, platformAddress),
    rentExemption(rpc, 0),
    priorityFeePrice(rpc),
  ]);
  if (receiver === undefined || platformWallet === undefined) return { status: "pending", reason: "SOL account lookup failed" };
  if (receiver === "not-a-wallet") return stopped(depositAddress, `destination ${destination} ${NOT_A_WALLET}. Ask the merchant for a normal wallet address`);
  if (platformWallet === "not-a-wallet") {
    return {
      status: "pending",
      reason: "the platform SOL address is not a wallet",
      review: `The platform Solana address ${platformAddress} ${NOT_A_WALLET}. ${nothingSent(depositAddress)} Fix PLATFORM_SOL_ADDRESS.`,
    };
  }
  if (rentMinimum === undefined || priorityFee === undefined) return { status: "pending", reason: "SOL rent or fee lookup failed" };

  const plan = planSol({
    total,
    priorityFee,
    feeRate: request.feeRate,
    platformLamports: platformWallet.lamports,
    destinationLamports: receiver.lamports,
    rentMinimum,
  });
  if (plan === undefined) {
    return { status: "too_small", reason: "SOL payout is too small after the fee and network cost, or to open an empty receiving wallet" };
  }

  const lifetime = await latestBlockhash(rpc);
  if (lifetime === undefined) return { status: "pending", reason: "SOL blockhash unavailable" };

  const instructions = computeBudget(SOL_PAYOUT_COMPUTE_UNITS, priorityFee);
  instructions.push(getTransferSolInstruction({ source: deposit, destination: toSolAddress(destination), amount: plan.merchantAmount }));
  const transfers: SavedTx["transfers"] = [{ kind: destinationKind, to: destination, amount: plan.merchantAmount.toString() }];
  if (plan.platformFee > 0n) {
    instructions.push(getTransferSolInstruction({ source: deposit, destination: toSolAddress(platformAddress), amount: plan.platformFee }));
    transfers.push({ kind: "platform_fee", to: platformAddress, amount: plan.platformFee.toString() });
  }
  const signed = await signTransaction(deposit, instructions, lifetime);

  const state: SavedTx = {
    v: 1,
    mode: "native",
    ...signed,
    lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    transfers,
  };
  return await saveAndSend(request, rpc, state, plan.platformFee, plan.networkCost);
}

// ---------- SPL tokens ----------

/**
 * `lamports` in token units at the current USD prices, rounded up (in the
 * platform's favour). undefined when a price is unavailable.
 */
async function lamportsInTokenUnits(lamports: bigint, token: SplToken, getPrice: PricePort): Promise<bigint | undefined> {
  if (lamports === 0n) return 0n;
  const [solText, tokenText] = await Promise.all([getPrice(SOL_ASSET, "usd"), getPrice(token.asset, "usd")]);
  const solPrice = solText === undefined ? undefined : decimalStrToBigInt(solText, PRICE_DECIMALS);
  const tokenPrice = tokenText === undefined ? undefined : decimalStrToBigInt(tokenText, PRICE_DECIMALS);
  if (solPrice === undefined || tokenPrice === undefined || solPrice <= 0n || tokenPrice <= 0n) return undefined;
  return ceilDivide(lamports * solPrice * 10n ** BigInt(token.decimals), tokenPrice * 10n ** BigInt(SOL_DECIMALS));
}

const tokenPayoutFee = (priorityFee: bigint) => networkFee(2n, TOKEN_PAYOUT_COMPUTE_UNITS, priorityFee);

/**
 * Payer-pays estimate for a token deposit, in token units: the fee of one
 * token payout whose receivers already hold the token, at today's priority
 * fee and prices. Creating a receiver's token account costs its rent on top.
 */
export async function estimateSplNetworkCost(deps: { rpc: SolanaRpc; token: SplToken; getPrice: PricePort }): Promise<bigint | undefined> {
  const price = await priorityFeePrice(deps.rpc);
  if (price === undefined) return undefined;
  return await lamportsInTokenUnits(tokenPayoutFee(price), deps.token, deps.getPrice);
}

type TokenReceiver = { ata: Address; exists: boolean } | { problem: string };

/** Can `owner` receive the token? exists=false: the payout creates the account. */
async function tokenReceiver(rpc: SolanaRpc, owner: string, token: SplToken): Promise<TokenReceiver | undefined> {
  const ata = await associatedTokenAccount(owner, token.mint);
  const account = await tokenAccountAt(rpc, ata, owner, token, "confirmed");
  if (account === undefined) return undefined;
  if (account === null) return { ata, exists: false };
  if ("problem" in account) return account;
  if (account.frozen) return { problem: `${ata} is frozen (the token's issuer can freeze accounts)` };
  return { ata, exists: true };
}

const splTransferProof = (depositAddress: string, token: SplToken) => {
  const proof = async (tx: ParsedTransaction, planned: SavedTx["transfers"][number]): Promise<bigint | undefined> => {
    if (planned.kind === "gas_top_up") return undefined;
    const [from, to] = await Promise.all([
      associatedTokenAccount(depositAddress, token.mint),
      associatedTokenAccount(planned.to, token.mint),
    ]);
    let delivered = 0n;
    for (const ix of tx.transaction.message.instructions) {
      if (ix.programId !== TOKEN_PROGRAM_ADDRESS) continue;
      const parsed = z
        .object({
          type: z.literal("transferChecked"),
          info: z.object({
            source: z.string(),
            destination: z.string(),
            mint: z.string(),
            authority: z.string(),
            tokenAmount: z.object({ amount: u64String }),
          }),
        })
        .safeParse(ix.parsed);
      if (!parsed.success) continue;
      const info = parsed.data.info;
      if (info.source === from && info.destination === to && info.mint === token.mint && info.authority === depositAddress) {
        delivered += BigInt(info.tokenAmount.amount);
      }
    }
    return delivered;
  };
  return async (tx: ParsedTransaction, planned: SavedTx["transfers"][number], feePayer: string): Promise<bigint | undefined> => {
    if (planned.kind !== "gas_top_up") return await proof(tx, planned);
    // What the gas wallet really spent: the fee and the rent of the accounts it created.
    const index = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey === feePayer);
    const before = tx.meta.preBalances[index];
    const after = tx.meta.postBalances[index];
    if (index !== 0 || before === undefined || after === undefined) return undefined;
    return BigInt(before) - BigInt(after);
  };
};

/** The token side of ChainAdapter.payout (src/chains/adapter.ts). Never touches the database. */
export async function payOutSplToken(request: PayoutRequest, deps: SplPayoutDeps): Promise<PayoutResult> {
  if (request.checkpoint !== undefined) {
    const state = readState(request.checkpoint.state);
    if (state?.mode !== "token" || state.feePayer === undefined) return unreadable(request.depositAddress);
    const feePayer = state.feePayer;
    const prove = splTransferProof(request.depositAddress, deps.token);
    return await follow(request, deps.rpc, state, () => startSplToken(request, deps), (tx, planned) => prove(tx, planned, feePayer));
  }
  return await startSplToken(request, deps);
}

async function startSplToken(request: PayoutRequest, deps: SplPayoutDeps): Promise<PayoutResult> {
  const { rpc, token } = deps;
  const { depositAddress, destination, destinationKind } = request;
  const what = `${token.asset} tokens`;

  if (deps.gasWalletKey === undefined) {
    return {
      status: "pending",
      reason: "SOL gas wallet is not configured",
      review: `The SOL gas wallet key is not configured, so this token payout can't pay its fee and waits. ${nothingSent(depositAddress, what)} Set SOL_GAS_WALLET_KEY in the server config.`,
    };
  }
  let gas: KeyPairSigner;
  try {
    gas = await loadSigner(openSecret("solana-gas-wallet-key", deps.gasWalletKey));
  } catch {
    return {
      status: "pending",
      reason: "SOL gas wallet key can't be opened",
      review: `The SOL gas wallet key can't be opened with the current data key, so this token payout waits. ${nothingSent(depositAddress, what)}`,
    };
  }

  const prepared = await prepare(request, deps, token.asset, what);
  if (!("deposit" in prepared)) return prepared;
  const { deposit, platformAddress } = prepared;

  const depositAta = await associatedTokenAccount(depositAddress, token.mint);
  const [final, seen] = await Promise.all([
    tokenAccountAt(rpc, depositAta, depositAddress, token, "finalized"),
    tokenAccountAt(rpc, depositAta, depositAddress, token, "confirmed"),
  ]);
  if (final === undefined || seen === undefined) return { status: "pending", reason: "deposit token balance unavailable" };
  if (final !== null && "problem" in final) return stopped(depositAddress, `the deposit's token account: ${final.problem}`, what);
  if (final?.frozen) {
    return {
      status: "failed",
      message: `Solana payout stopped: the deposit's ${token.asset} account ${depositAta} is frozen by the token's issuer, so nobody can move it. The tokens are still at deposit address ${depositAddress}. Contact the issuer.`,
      transfers: [],
    };
  }
  const received = final?.amount ?? 0n;
  const seenAmount = seen !== null && !("problem" in seen) ? seen.amount : 0n;
  // Send exactly what is final; a payment still arriving would be left behind.
  if (seenAmount !== received) return { status: "pending", reason: "a payment to the deposit is not finalized yet" };
  if (received < request.minimumAmount || received === 0n) return { status: "pending", reason: "the deposit holds less than the payout minimum" };

  const [receiverWallet, receiver, platformWallet, platform] = await Promise.all([
    checkWallet(rpc, destination),
    tokenReceiver(rpc, destination, token),
    checkWallet(rpc, platformAddress),
    tokenReceiver(rpc, platformAddress, token),
  ]);
  if (receiverWallet === undefined || receiver === undefined || platformWallet === undefined || platform === undefined) {
    return { status: "pending", reason: "SOL account lookup failed" };
  }
  if (receiverWallet === "not-a-wallet") {
    return stopped(depositAddress, `destination ${destination} ${NOT_A_WALLET}. Ask the merchant for a normal wallet address`, what);
  }
  if ("problem" in receiver) return stopped(depositAddress, `destination ${destination} can't receive ${token.asset}: ${receiver.problem}`, what);
  if (platformWallet === "not-a-wallet" || "problem" in platform) {
    const problem = platformWallet === "not-a-wallet" ? NOT_A_WALLET : `can't receive ${token.asset}: ${(platform as { problem: string }).problem}`;
    return {
      status: "pending",
      reason: "the platform SOL address can't receive the token",
      review: `The platform Solana address ${platformAddress} ${problem}. ${nothingSent(depositAddress, what)} Fix PLATFORM_SOL_ADDRESS.`,
    };
  }

  const [tokenRent, rentMinimum, priorityFee] = await Promise.all([
    rentExemption(rpc, TOKEN_ACCOUNT_SIZE),
    rentExemption(rpc, 0),
    priorityFeePrice(rpc),
  ]);
  if (tokenRent === undefined || rentMinimum === undefined || priorityFee === undefined) {
    return { status: "pending", reason: "SOL rent or fee lookup failed" };
  }

  // Every token payout makes a platform transfer: it carries at least the
  // reimbursement of the gas wallet's spend, which is never 0.
  const accountsToCreate = (receiver.exists ? 0n : 1n) + (platform.exists ? 0n : 1n);
  const gasSpend = tokenPayoutFee(priorityFee) + accountsToCreate * tokenRent;
  const reimbursement = await lamportsInTokenUnits(gasSpend, token, deps.getPrice);
  if (reimbursement === undefined) return { status: "pending", reason: `no SOL/${token.asset} price to convert the network cost` };
  const split = splitPayout({ received, networkCost: reimbursement, feeRate: request.feeRate });
  if (split === undefined) return { status: "too_small", reason: `${token.asset} payout is too small after the fee, the network cost and the rent` };
  const platformAmount = split.platformFee + reimbursement;

  // The gas wallet must also keep the rent minimum itself, or Solana refuses the transaction.
  const gasBalance = await lamportsOf(rpc, gas.address, "confirmed");
  if (gasBalance === undefined) return { status: "pending", reason: "SOL gas wallet lookup failed" };
  if (gasBalance < gasSpend + rentMinimum) {
    return {
      status: "pending",
      reason: "SOL gas wallet is short of funds",
      review: `The SOL gas wallet ${gas.address} holds ${gasBalance} lamports and this token payout needs ${gasSpend + rentMinimum} (its fee and rent, plus the gas wallet's own rent minimum). Fund the gas wallet; the payout continues by itself. The tokens are still at deposit address ${depositAddress}.`,
    };
  }

  const lifetime = await latestBlockhash(rpc);
  if (lifetime === undefined) return { status: "pending", reason: "SOL blockhash unavailable" };

  const mint = toSolAddress(token.mint);
  const instructions = computeBudget(TOKEN_PAYOUT_COMPUTE_UNITS, priorityFee);
  const pay = (owner: string, ata: Address, exists: boolean, amount: bigint) => {
    if (!exists) {
      instructions.push(getCreateAssociatedTokenIdempotentInstruction({ payer: gas, ata, owner: toSolAddress(owner), mint }));
    }
    instructions.push(
      getTransferCheckedInstruction({ source: depositAta, mint, destination: ata, authority: deposit, amount, decimals: token.decimals }),
    );
  };
  pay(destination, receiver.ata, receiver.exists, split.merchantAmount);
  pay(platformAddress, platform.ata, platform.exists, platformAmount);
  const signed = await signTransaction(gas, instructions, lifetime);

  const state: SavedTx = {
    v: 1,
    mode: "token",
    ...signed,
    lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    feePayer: gas.address,
    transfers: [
      // In lamports: the gas wallet's spend for this deposit. The other two are in token units.
      { kind: "gas_top_up", to: depositAddress, amount: gasSpend.toString() },
      { kind: destinationKind, to: destination, amount: split.merchantAmount.toString() },
      { kind: "platform_fee", to: platformAddress, amount: platformAmount.toString() },
    ],
  };
  // networkCost in token units: the gas wallet's spend, converted.
  return await saveAndSend(request, rpc, state, split.platformFee, reimbursement);
}
