import type { AssetId } from "../assets/payout-address.js";
import type {
  ChainAdapter,
  ChainRegistry,
  PayoutCheckpoint,
  PayoutRequest,
  PayoutResult,
} from "../chains/adapter.js";
import { User } from "../database/users.model.js";
import { splitPayout } from "../money/payout-split.js";
import type { SwapPort, SwapQuote } from "../swap/swap-port.js";

// Paying a deposit into a swap, and proving the swap delivered. Shared by the
// merchant payout (invoice.watcher.ts) and the refund route's swap to the
// receive coin (closed-watch.ts). Rules: docs/domain.md ("Swap mode").

/** The merchant's max loss when neither the invoice nor the merchant has one (spec story 28). */
export const DEFAULT_SWAP_MAX_LOSS_BPS = 50;

// The chain adapter works out the exact amount only when it builds the
// payout, and the provider needs that amount before it opens a deposit
// address. So: quote an estimate, let the adapter plan, and if its plan sends
// another amount, refuse its save (nothing is sent) and quote that amount.
const QUOTE_ATTEMPTS = 3;

export type SwapPayout =
  /** The adapter's answer; `quote` is the one saved with its checkpoint, if any. */
  | { kind: "payout"; result: PayoutResult; quote: SwapQuote | undefined }
  /** Fees, network cost or the provider's minimum would take it all. Nothing was sent. */
  | { kind: "too_small"; reason: string }
  /** Not now; nothing was sent. `review` is a note for a person. */
  | { kind: "wait"; reason: string; review?: string };

/** What the plan sends into the swap, or undefined if it is not one swap_deposit transfer. */
function swapDepositOf(plan: PayoutCheckpoint["plan"]): bigint | undefined {
  const deposits = plan.transfers.filter((t) => t.kind === "swap_deposit");
  return deposits.length === 1 ? deposits[0]!.amount : undefined;
}

/**
 * Pays what the deposit holds (`received`, as recorded) into a new swap from
 * the adapter's asset to `to`, for `recipient`. `save` stores the checkpoint
 * together with the quote; it is called only for a plan that sends exactly the
 * quoted amount, so the provider (EXACT_INPUT) never gets a different one.
 */
export async function payIntoSwap(input: {
  adapter: ChainAdapter;
  swap: SwapPort;
  to: AssetId;
  recipient: string;
  maxLossBps: number;
  received: bigint;
  request: Pick<PayoutRequest, "depositAddress" | "depositKey" | "feeRate" | "minimumAmount">;
  save: (next: PayoutCheckpoint, quote: SwapQuote) => Promise<boolean>;
}): Promise<SwapPayout> {
  const { adapter, request } = input;

  const estimate = await adapter.estimateNetworkCost();
  if (estimate === undefined) return { kind: "wait", reason: "network cost estimate unavailable" };
  const split = splitPayout({
    received: input.received,
    networkCost: typeof estimate === "bigint" ? estimate : 0n,
    feeRate: request.feeRate,
  });
  if (split === undefined) return { kind: "too_small", reason: "fees and network cost would take it all" };

  let amountIn = split.merchantAmount;
  for (let attempt = 0; attempt < QUOTE_ATTEMPTS; attempt += 1) {
    const answer = await input.swap.quote({
      from: adapter.asset,
      to: input.to,
      amountIn,
      recipient: input.recipient,
      refundTo: request.depositAddress,
      maxLossBps: input.maxLossBps,
    });
    if (answer.kind === "too_small") {
      return { kind: "too_small", reason: `below the swap's minimum (${answer.reason})` };
    }
    if (answer.kind === "unavailable") return { kind: "wait", reason: `swap quote: ${answer.reason}` };
    const quote = answer.quote;
    if (!adapter.isValidAddress(quote.depositAddress) || quote.depositAddress === request.depositAddress) {
      return {
        kind: "wait",
        reason: "unusable swap deposit address",
        review: `The swap provider gave deposit address "${quote.depositAddress}", which is not a usable ${adapter.asset} address. Nothing was sent: the funds are still at deposit address ${request.depositAddress}. The watcher asks for a new quote each pass.`,
      };
    }

    // "none": the adapter stopped before planning (it waits, fails or finds it too small).
    const gate: { planned: bigint | undefined | "none"; saved: boolean } = { planned: "none", saved: false };
    const result = await adapter.payout({
      ...request,
      destination: quote.depositAddress,
      destinationKind: "swap_deposit",
      receiveAsset: adapter.asset,
      checkpoint: undefined,
      saveCheckpoint: async (next) => {
        gate.planned = swapDepositOf(next.plan);
        if (gate.planned !== quote.amountIn) return false;
        gate.saved = await input.save(next, quote);
        return gate.saved;
      },
    });

    const planned = gate.planned;
    if (planned === "none" || planned === quote.amountIn) {
      return { kind: "payout", result, quote: gate.saved ? quote : undefined };
    }
    if (planned === undefined) {
      return {
        kind: "wait",
        reason: "the payout plan has no single swap deposit",
        review: `The ${adapter.asset} adapter planned a swap payout without exactly one swap_deposit transfer, so nothing was sent. The funds are still at deposit address ${request.depositAddress}. This is an adapter bug.`,
      };
    }
    if (planned <= 0n) return { kind: "too_small", reason: "nothing left for the swap" };
    amountIn = planned;
  }
  return { kind: "wait", reason: "the payout amount kept changing between quotes; nothing was sent" };
}

const isHex = (txid: string) => /^(0x)?[0-9a-fA-F]+$/.test(txid);
// Hex hashes are compared without case or 0x (providers and indexers differ);
// anything else (base58, base64) exactly.
const sameTxid = (a: string, b: string) =>
  isHex(a) && isHex(b) ? a.toLowerCase().replace(/^0x/, "") === b.toLowerCase().replace(/^0x/, "") : a === b;

export type Delivery =
  | { kind: "seen"; amount: bigint; txids: string[] }
  | { kind: "not_seen"; reason: string }
  /** No way to look it up now (lookup failed, or no adapter for the receive coin). */
  | { kind: "unknown"; reason: string };

/**
 * The provider's delivery, as the receive coin's own chain shows it: the
 * payments to `recipient` whose txid is one the provider names, each with
 * the receive coin's required confirmations.
 */
export async function seenDelivery(input: {
  chains: ChainRegistry;
  receiveAsset: string;
  recipient: string;
  deliveryTxids: string[];
}): Promise<Delivery> {
  if (input.deliveryTxids.length === 0) return { kind: "not_seen", reason: "the provider names no delivery transaction" };
  const adapter = (input.chains as Record<string, ChainAdapter | undefined>)[input.receiveAsset];
  if (adapter === undefined) return { kind: "unknown", reason: `no ${input.receiveAsset} chain adapter to check the delivery` };

  const payments = await adapter.getPayments(input.recipient);
  if (payments === undefined) return { kind: "unknown", reason: `the ${input.receiveAsset} lookup of ${input.recipient} failed or is incomplete` };

  const delivered = payments.filter((p) => input.deliveryTxids.some((txid) => sameTxid(txid, p.txid)));
  if (delivered.length === 0) return { kind: "not_seen", reason: "the delivery is not on the receive chain yet" };
  if (delivered.some((p) => p.confirmations < adapter.requiredConfirmations)) {
    return { kind: "not_seen", reason: "the delivery is waiting for confirmations" };
  }
  return {
    kind: "seen",
    amount: delivered.reduce((sum, p) => sum + p.amount, 0n),
    txids: delivered.map((p) => p.txid),
  };
}

/** The swap record of a new swap (the invoice's `swap`, or a refund route's). */
export function swapRecord(quote: SwapQuote, receiveAsset: string, recipient: string): Record<string, unknown> {
  return {
    provider: quote.provider,
    deposit_address: quote.depositAddress,
    recipient,
    receive_crypto: receiveAsset,
    status: "PENDING_DEPOSIT",
    deadline: new Date(quote.deadline).toISOString(),
    amount_in: quote.amountIn.toString(),
    min_amount_out: quote.minAmountOut.toString(),
    amount_delivered: "0",
    amount_refunded: "0",
    quote_response: quote.record,
  };
}

/** The same record as `$set` paths under `prefix` (e.g. "swap."). */
export function swapRecordFields(
  prefix: string,
  quote: SwapQuote,
  receiveAsset: string,
  recipient: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(swapRecord(quote, receiveAsset, recipient)).map(([field, value]) => [`${prefix}${field}`, value]),
  );
}

/** The merchant's max loss for this invoice's swaps, in basis points (50-500). */
export async function maxLossOf(invoice: { swap_max_loss_bps?: number | null; user_id: string }): Promise<number> {
  const valid = (bps: number | null | undefined): bps is number => Number.isInteger(bps) && bps! >= 50 && bps! <= 500;
  if (valid(invoice.swap_max_loss_bps)) return invoice.swap_max_loss_bps;
  const merchant = await User.findOne({ user_id: invoice.user_id }).select("swap_max_loss_bps").lean().exec();
  return valid(merchant?.swap_max_loss_bps) ? merchant.swap_max_loss_bps : DEFAULT_SWAP_MAX_LOSS_BPS;
}

/** Tells the provider the deposit was sent. Only a hint: it finds the deposit without it. */
export async function hintSwapStart(swap: SwapPort, depositAddress: string, txid: string): Promise<void> {
  try {
    if (!(await swap.start({ depositAddress, txid }))) console.warn("Swap provider did not take the deposit hint:", depositAddress);
  } catch (error) {
    console.warn("Swap deposit hint failed:", depositAddress, error instanceof Error ? error.message : error);
  }
}

/** The refund address the provider was given, from its saved quote. */
export function refundToOf(quoteResponse: unknown): string | undefined {
  const request = (quoteResponse as { quoteRequest?: { refundTo?: unknown } } | null)?.quoteRequest;
  return typeof request?.refundTo === "string" && request.refundTo ? request.refundTo : undefined;
}

/** The quote's minimum output; older swaps have it only in the saved quote. */
export function minAmountOutOf(swap: { min_amount_out?: string | null; quote_response?: unknown }): bigint | undefined {
  const text = swap.min_amount_out || (swap.quote_response as { quote?: { minAmountOut?: unknown } } | null)?.quote?.minAmountOut;
  return typeof text === "string" && /^[0-9]+$/.test(text) ? BigInt(text) : undefined;
}
