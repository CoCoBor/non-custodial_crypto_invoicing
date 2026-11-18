import { z } from "zod";

import {
  DepositUnavailableError,
  type ChainPayment,
  type NewDeposit,
  type PayoutCheckpoint,
  type PayoutRequest,
  type PayoutResult,
  type Transfer,
} from "../chains/adapter.js";
import { isValidMoneroAddress, moneroAddressKind } from "../chains/monero-address.js";
import type { MoneroRpc, MoneroRpcAnswer } from "../chains/monero-rpc.js";
import { ceilDivide } from "../money/format.js";
import { splitPayout } from "../money/payout-split.js";

// Monero: every invoice's deposit is a subaddress of ONE platform wallet,
// run by our own monero-wallet-rpc (account 0). The wallet holds the keys,
// so an invoice stores only the subaddress index. A payout spends only that
// subaddress's outputs (subaddr_indices), the network fee comes off the
// destination's output (subtract_fee_from_outputs), and the chain proves
// what each receiver got (check_tx_key with the transaction's secret key).

const ACCOUNT = 0;

// Priority 1 ("unimportant") pays the daemon's lowest fee per byte, fees[0]
// of get_fee_estimate; the estimate below uses the same one.
const PRIORITY = 1;

// A normal output unlocks 10 blocks after its block (CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE).
const NORMAL_LOCK_BLOCKS = 10;

// Wallet error codes (wallet_rpc_server_error_codes.h).
const ERROR_ADDRESS_NOT_IN_WALLET = -2;
const ERROR_TX_NOT_POSSIBLE = -16;
const ERROR_NOT_ENOUGH_MONEY = -17;

export type XmrDeps = {
  /** The platform wallet. undefined: not configured; no deposits, payouts wait. */
  wallet: MoneroRpc | undefined;
  /** A monerod, for the fee estimate only. */
  daemon: MoneroRpc | undefined;
  /** Receives the platform fee. Standard address or subaddress. */
  platformAddress: string | undefined;
};

const piconero = z
  .union([z.number().int().nonnegative(), z.bigint().nonnegative()])
  .transform((value) => BigInt(value));
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const subaddressIndex = z.object({ major: z.number().int(), minor: z.number().int() });

function resultOf<T extends z.ZodType>(answer: MoneroRpcAnswer | undefined, schema: T): z.output<T> | undefined {
  if (answer === undefined || !("result" in answer)) return undefined;
  const parsed = schema.safeParse(answer.result);
  return parsed.success ? parsed.data : undefined;
}

function errorOf(answer: MoneroRpcAnswer | undefined) {
  return answer !== undefined && "error" in answer ? answer.error : undefined;
}

// ---------- Deposits ----------

export async function newXmrDeposit(wallet: MoneroRpc | undefined): Promise<NewDeposit> {
  if (wallet === undefined) {
    throw new DepositUnavailableError("xmr", "the platform's monero-wallet-rpc is not configured (MONERO_WALLET_RPC_URL)");
  }
  const created = resultOf(
    await wallet.call("create_address", { account_index: ACCOUNT }),
    z.object({ address: z.string(), address_index: z.number().int().positive() }),
  );
  if (created === undefined || moneroAddressKind(created.address) !== "subaddress") {
    throw new DepositUnavailableError("xmr", "the platform's monero-wallet-rpc did not make a subaddress");
  }
  return { address: created.address, key: { kind: "subaddress", index: created.address_index } };
}

/** The account-0 subaddress index of `address` in the platform wallet; undefined if it isn't one, or on failure. */
async function subaddressIndexOf(wallet: MoneroRpc, address: string): Promise<number | undefined> {
  const found = resultOf(await wallet.call("get_address_index", { address }), z.object({ index: subaddressIndex }));
  if (found === undefined || found.index.major !== ACCOUNT || found.index.minor < 1) return undefined;
  return found.index.minor;
}

// ---------- Payments ----------

const transferEntry = z.object({
  txid: hex64,
  amount: piconero,
  confirmations: z.number().int().nonnegative().optional(),
  timestamp: z.number().int().nonnegative(),
  unlock_time: piconero,
  double_spend_seen: z.boolean(),
  subaddr_index: subaddressIndex,
});

/**
 * Incoming payments to one deposit subaddress, from the wallet's own view:
 * mined ("in") and mempool ("pool") transfers. One entry per transaction.
 */
export async function getXmrPayments(
  wallet: MoneroRpc | undefined,
  address: string,
): Promise<ChainPayment[] | undefined> {
  if (wallet === undefined) return undefined;
  const index = await subaddressIndexOf(wallet, address);
  if (index === undefined) return undefined;

  const listed = resultOf(
    await wallet.call("get_transfers", { in: true, pool: true, account_index: ACCOUNT, subaddr_indices: [index] }),
    // Monero leaves out a list that is empty.
    z.object({ in: z.array(transferEntry).optional(), pool: z.array(transferEntry).optional() }),
  );
  if (listed === undefined) return undefined;

  const byTxid = new Map<string, ChainPayment>();
  const add = (entry: z.output<typeof transferEntry>, confirmations: number) => {
    if (entry.subaddr_index.major !== ACCOUNT || entry.subaddr_index.minor !== index) return;
    // A time-locked output can't be spent until its unlock time: not money
    // the payout can forward, so not a payment.
    if (entry.unlock_time !== 0n) return;
    const seenAt = entry.timestamp > 0 ? entry.timestamp * 1000 : undefined;
    const known = byTxid.get(entry.txid);
    if (known === undefined) {
      byTxid.set(entry.txid, { txid: entry.txid, amount: entry.amount, confirmations, ...(seenAt !== undefined && { seenAt }) });
      return;
    }
    known.amount += entry.amount;
    known.confirmations = Math.min(known.confirmations, confirmations);
    if (seenAt !== undefined) known.seenAt = Math.min(known.seenAt ?? seenAt, seenAt);
  };

  for (const entry of listed.in ?? []) add(entry, entry.confirmations ?? 0);
  const mined = new Set(byTxid.keys());
  for (const entry of listed.pool ?? []) {
    // A pool transaction the node saw a double spend of may never be mined.
    if (mined.has(entry.txid) || entry.double_spend_seen) continue;
    add(entry, 0);
  }
  return [...byTxid.values()];
}

// ---------- Network cost ----------

// Weight of a payout with one input and two destinations, at least one a
// subaddress: the widest a payout of one payment gets. Measured on
// monero-wallet-rpc v0.18.5.4 regtest (CLSAG, Bulletproofs+, view tags):
// 1,562; two standard addresses 1,496; one destination (0% fee) 1,507. The
// wallet's own estimate_tx_size_and_weight says 1,536, too low for a
// subaddress. A hard fork that changes the transaction format changes it.
const WIDEST_ONE_INPUT_PAYOUT_WEIGHT = 1_562n;

/**
 * Payer-pays estimate, in piconero: a payout of one payment (one input) to
 * the widest two destinations, at the daemon's lowest fee per byte (the
 * priority the payout uses). "unsupported" without a daemon; undefined when
 * it fails.
 */
export async function estimateXmrNetworkCost(deps: XmrDeps): Promise<bigint | "unsupported" | undefined> {
  if (deps.daemon === undefined) return "unsupported";
  const fees = resultOf(
    await deps.daemon.call("get_fee_estimate"),
    z.object({ fees: z.array(piconero).min(1), quantization_mask: piconero }),
  );
  if (fees === undefined || fees.quantization_mask < 1n) return undefined;
  return feeFor(WIDEST_ONE_INPUT_PAYOUT_WEIGHT, fees.fees[0]!, fees.quantization_mask);
}

/** What the wallet charges: weight × fee per byte, rounded up to the quantization mask. */
function feeFor(weight: bigint, feePerByte: bigint, mask: bigint): bigint {
  return ceilDivide(weight * feePerByte, mask) * mask;
}

// ---------- Payout ----------

const checkpointState = z.object({
  v: z.literal(1),
  txid: hex64,
  txKey: z.string().regex(/^(?:[0-9a-f]{64})+$/),
  metadata: z.string().regex(/^[0-9a-f]+$/),
});

/**
 * The XMR side of ChainAdapter.payout (src/chains/adapter.ts). Pays
 * request.destination (and the platform) from the deposit's subaddress, or
 * follows the transaction saved in request.checkpoint. Never touches the
 * database.
 */
export async function payOutXmr(request: PayoutRequest, deps: XmrDeps): Promise<PayoutResult> {
  const { depositAddress, depositKey } = request;
  if (depositKey.kind !== "subaddress" || !Number.isSafeInteger(depositKey.index) || depositKey.index < 1) {
    return {
      status: "failed",
      message: `XMR payout stopped: deposit address ${depositAddress} has no platform-wallet subaddress index. Nothing was sent. Find the subaddress in the platform wallet (monero-wallet-cli: address all) and move its funds by hand.`,
      transfers: [],
    };
  }
  const index = depositKey.index;
  const where = `all funds are still in the platform wallet at subaddress ${index} (deposit address ${depositAddress})`;
  const wallet = deps.wallet;
  if (wallet === undefined) {
    return {
      status: "pending",
      reason: "the platform's monero-wallet-rpc is not configured",
      review: `XMR payout waits: MONERO_WALLET_RPC_URL is not set. ${capitalised(where)}.`,
    };
  }
  return request.checkpoint === undefined
    ? await buildAndSend(request, { ...deps, wallet }, index, where)
    : await follow(request, request.checkpoint, wallet);
}

function capitalised(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function buildAndSend(
  request: PayoutRequest,
  deps: XmrDeps & { wallet: MoneroRpc },
  index: number,
  where: string,
): Promise<PayoutResult> {
  const { wallet, platformAddress } = deps;
  const { depositAddress, destination, destinationKind, feeRate } = request;
  const feeExempt = request.feeExempt ?? 0n;
  const pending = (reason: string, review?: string): PayoutResult => ({
    status: "pending",
    reason,
    ...(review !== undefined && { review: `XMR payout waits: ${review} Nothing was sent: ${where}.` }),
  });
  const fail = (reason: string): PayoutResult => ({
    status: "failed",
    message: `XMR payout stopped: ${reason}. Nothing was sent: ${where}. Fix the cause, then set the invoice back to "confirmed" to retry, or send the funds on by hand from the platform wallet (monero-wallet-cli: transfer with subaddress index ${index}).`,
    transfers: [],
  });

  if (request.receiveAsset !== "xmr") return fail(`an XMR deposit can't be paid out as ${request.receiveAsset}`);
  if (!isValidMoneroAddress(destination)) {
    return fail(`destination "${destination}" is not a mainnet Monero standard address or subaddress (integrated addresses can't be paid with the platform fee)`);
  }
  if (destination === depositAddress) return fail("the destination is the deposit address itself");
  if (destination === platformAddress) return fail("the destination is the platform's own fee address");

  const opened = resultOf(
    await wallet.call("get_address", { account_index: ACCOUNT, address_index: [index] }),
    z.object({ addresses: z.array(z.object({ address: z.string(), address_index: z.number().int() })) }),
  );
  if (opened === undefined) return pending("the platform wallet did not answer");
  const subaddress = opened.addresses.find((entry) => entry.address_index === index)?.address;
  if (subaddress !== depositAddress) {
    return pending(
      "the open wallet does not hold this deposit",
      `the wallet open in monero-wallet-rpc has ${subaddress ?? "no address"} at subaddress ${index}, not the deposit address: is the right wallet open?`,
    );
  }

  const owner = await wallet.call("get_address_index", { address: destination });
  if (owner === undefined) return pending("the platform wallet did not answer");
  if ("result" in owner) return fail("the destination is an address of the platform wallet itself");
  if (owner.error.code !== ERROR_ADDRESS_NOT_IN_WALLET) return pending("the platform wallet refused an address lookup");

  const balance = resultOf(
    await wallet.call("get_balance", { account_index: ACCOUNT, address_indices: [index] }),
    z.object({
      per_subaddress: z
        .array(
          z.object({
            address_index: z.number().int(),
            balance: piconero,
            unlocked_balance: piconero,
            blocks_to_unlock: z.number().int().nonnegative(),
            time_to_unlock: z.number().int().nonnegative(),
          }),
        )
        .optional(),
    }),
  );
  if (balance === undefined) return pending("the platform wallet's balance is unavailable");
  const held = balance.per_subaddress?.find((entry) => entry.address_index === index);
  const unlocked = held?.unlocked_balance ?? 0n;
  // A payout sweeps the subaddress, so it waits for outputs that unlock
  // within the normal 10 blocks. An output locked longer (a payer's unlock
  // time) is left behind rather than holding up the payout for good.
  if (
    held !== undefined &&
    held.balance > unlocked &&
    held.time_to_unlock === 0 &&
    held.blocks_to_unlock > 0 &&
    held.blocks_to_unlock <= NORMAL_LOCK_BLOCKS
  ) {
    return pending(`waiting ${held.blocks_to_unlock} blocks for the deposit's outputs to unlock`);
  }
  if (unlocked < request.minimumAmount || unlocked === 0n) return pending("unlocked XMR at the deposit is below the payout minimum");

  const outputs = resultOf(
    await wallet.call("incoming_transfers", { transfer_type: "available", account_index: ACCOUNT, subaddr_indices: [index] }),
    z.object({
      transfers: z
        .array(
          z.object({
            amount: piconero,
            key_image: z.string(),
            spent: z.boolean(),
            frozen: z.boolean(),
            unlocked: z.boolean(),
            subaddr_index: subaddressIndex,
          }),
        )
        .optional(),
    }),
  );
  if (outputs === undefined) return pending("the deposit's outputs are unavailable");
  const spendable = (outputs.transfers ?? []).filter(
    (output) =>
      output.subaddr_index.major === ACCOUNT &&
      output.subaddr_index.minor === index &&
      output.unlocked &&
      !output.spent &&
      !output.frozen,
  );
  const received = spendable.reduce((sum, output) => sum + output.amount, 0n);
  // Read twice, the same: no output unlocked in between, so the transaction
  // below can spend exactly these and owe no change.
  if (received !== unlocked) return pending("the deposit's outputs changed while they were read");

  // The platform's share comes first; the fee comes off the destination's output.
  const share = splitPayout({ received, networkCost: 0n, feeRate, feeExempt });
  if (share === undefined) return { status: "too_small", reason: "XMR payout is too small after the platform fee" };
  const platformFee = share.platformFee;
  if (platformFee > 0n && (platformAddress === undefined || !isValidMoneroAddress(platformAddress))) {
    return pending("PLATFORM_XMR_ADDRESS is not set", "PLATFORM_XMR_ADDRESS is not set, so the platform fee has nowhere to go.");
  }

  const destinations = [{ address: destination, amount: received - platformFee }];
  // Monero refuses a zero-amount destination: at a 0% fee there is no platform output.
  if (platformFee > 0n) destinations.push({ address: platformAddress!, amount: platformFee });

  const built = await wallet.call("transfer", {
    destinations,
    account_index: ACCOUNT,
    subaddr_indices: [index],
    subtract_fee_from_outputs: [0],
    priority: PRIORITY,
    do_not_relay: true,
    get_tx_key: true,
    get_tx_metadata: true,
  });
  const buildError = errorOf(built);
  if (buildError?.code === ERROR_TX_NOT_POSSIBLE || buildError?.code === ERROR_NOT_ENOUGH_MONEY) {
    return { status: "too_small", reason: `XMR payout is too small after fees (wallet: ${buildError.message.slice(0, 200)})` };
  }
  if (buildError !== undefined) {
    return pending("the platform wallet could not build the payout", `the platform wallet could not build it (${buildError.code}: ${buildError.message.slice(0, 200)}).`);
  }
  const tx = resultOf(
    built,
    z.object({
      tx_hash: hex64,
      tx_key: z.string().regex(/^(?:[0-9a-f]{64})+$/),
      tx_metadata: z.string().regex(/^[0-9a-f]+$/),
      fee: piconero,
      amounts_by_dest: z.object({ amounts: z.array(piconero) }),
      spent_key_images: z.object({ key_images: z.array(z.string()) }),
    }),
  );
  if (tx === undefined) return pending("the platform wallet's transfer reply was unreadable");

  // Check what was built before it can be sent: it spends exactly this
  // subaddress's outputs, and pays F1 with its own fee as the network cost.
  const spentImages = [...tx.spent_key_images.key_images].sort();
  const ownImages = spendable.map((output) => output.key_image).sort();
  const split = splitPayout({ received, networkCost: tx.fee, feeRate, feeExempt });
  const [destinationAmount, platformAmount] = tx.amounts_by_dest.amounts;
  if (
    spentImages.join() !== ownImages.join() ||
    split === undefined ||
    split.platformFee !== platformFee ||
    tx.amounts_by_dest.amounts.length !== destinations.length ||
    destinationAmount !== split.merchantAmount ||
    (platformFee > 0n && platformAmount !== platformFee)
  ) {
    if (split === undefined) return { status: "too_small", reason: "XMR payout is too small after fees" };
    return pending(
      "the built transaction does not match the plan",
      `the transaction the wallet built (${tx.tx_hash}) does not match the planned split, or spends other outputs; it was not sent.`,
    );
  }

  const transfers: Transfer[] = [{ kind: destinationKind, to: destination, amount: split.merchantAmount, txid: tx.tx_hash }];
  if (platformFee > 0n) transfers.push({ kind: "platform_fee", to: platformAddress!, amount: platformFee, txid: tx.tx_hash });
  const checkpoint: PayoutCheckpoint = {
    state: JSON.stringify({ v: 1, txid: tx.tx_hash, txKey: tx.tx_key, metadata: tx.tx_metadata }),
    plan: { transfers, platformFee, networkCost: tx.fee },
  };
  if (!(await request.saveCheckpoint(checkpoint))) return pending("another run saved this payout first");

  await relay(wallet, tx.tx_metadata, request.depositAddress, tx.tx_hash);
  return pending("sent; waiting for its first confirmation");
}

async function relay(wallet: MoneroRpc, metadata: string, depositAddress: string, txid: string) {
  const relayed = await wallet.call("relay_tx", { hex: metadata });
  const error = errorOf(relayed);
  if (relayed !== undefined && error === undefined) console.log("XMR payout relayed:", depositAddress, txid);
  return error;
}

const txKeyProof = z.object({ received: piconero, confirmations: z.number().int().nonnegative(), in_pool: z.boolean() });

async function follow(request: PayoutRequest, checkpoint: PayoutCheckpoint, wallet: MoneroRpc): Promise<PayoutResult> {
  const { depositAddress } = request;
  let saved: z.output<typeof checkpointState>;
  try {
    saved = checkpointState.parse(JSON.parse(checkpoint.state));
  } catch {
    return {
      status: "pending",
      reason: "unreadable saved XMR transaction",
      review: `The saved XMR payout transaction is unreadable. Funds may still be in the platform wallet at deposit address ${depositAddress}; check the wallet's outgoing transfers before sending anything.`,
    };
  }
  const planned = checkpoint.plan.transfers;
  if (planned.length === 0) return { status: "pending", reason: "the saved XMR payout has no planned transfers", review: `The saved XMR payout ${saved.txid} lists no transfers; check it by hand.` };

  // The transaction's secret key proves, from the chain, what an address
  // got. An error means the daemon does not know the transaction.
  const checkTxKey = (address: string) => wallet.call("check_tx_key", { txid: saved.txid, tx_key: saved.txKey, address });
  const first = await checkTxKey(planned[0]!.to);
  if (first === undefined) return { status: "pending", reason: "the platform wallet did not answer" };

  if ("error" in first) {
    // Not on chain or in the pool: send the same signed transaction again.
    // It has one txid and spends the same outputs, so it lands at most once;
    // a new one is never built while this one could still land.
    const error = await relay(wallet, saved.metadata, depositAddress, saved.txid);
    if (error === undefined) return { status: "pending", reason: "sent again; waiting for it to be seen" };
    return {
      status: "pending",
      reason: "the saved XMR payout could not be relayed",
      review: `The saved XMR payout ${saved.txid} is not on chain and relaying it again failed (${error.code}: ${error.message.slice(0, 200)}). If its outputs were spent by another transaction it can never land; check the platform wallet's subaddress for deposit address ${depositAddress} before sending anything.`,
    };
  }

  const firstProof = resultOf(first, txKeyProof);
  if (firstProof === undefined) return { status: "pending", reason: "the payout's proof was unreadable" };
  if (firstProof.in_pool || firstProof.confirmations < 1) return { status: "pending", reason: "waiting for the payout's first confirmation" };

  const transfers: Transfer[] = [];
  const notes: string[] = [];
  for (const [position, transfer] of planned.entries()) {
    const shown = position === 0 ? firstProof : resultOf(await checkTxKey(transfer.to), txKeyProof);
    if (shown === undefined) return { status: "pending", reason: "the payout's proof is unavailable" };
    if (shown.received !== transfer.amount) {
      if (transfer.kind === "platform_fee") {
        notes.push(`platform fee: planned ${transfer.amount}, proven ${shown.received} piconero`);
      } else {
        return {
          status: "failed",
          message: `XMR payout ${saved.txid} landed, but ${transfer.to} received ${shown.received} piconero, not the planned ${transfer.amount}. The transaction cannot be undone; check it with its tx key (monero-wallet-cli: get_tx_key ${saved.txid}, check_tx_key) and settle the difference by hand.`,
          transfers: planned.map((t, i) => (i === position ? { ...t, amount: shown.received } : t)),
        };
      }
    }
    transfers.push({ ...transfer, amount: shown.received });
  }
  return { status: "paid", transfers, ...(notes.length > 0 && { note: `XMR payout ${saved.txid}: ${notes.join("; ")}` }) };
}
