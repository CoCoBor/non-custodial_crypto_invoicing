import { checkPayoutAddress, isAssetId } from "../assets/payout-address.js";
import type {
  ChainAdapter,
  ChainPayment,
  ChainRegistry,
  PayoutCheckpoint,
  PayoutRequest,
  PayoutResult,
  Transfer,
} from "../chains/adapter.js";
import { chainAdapters, depositAssets } from "../chains/registry.js";
import { Invoice } from "../database/invoices.model.js";
import { LATE_PAYMENT_NOTE_PREFIX } from "../swap/near.js";
import { swapProvider } from "../swap/registry.js";
import type { SwapPort, SwapRef } from "../swap/swap-port.js";
import { closedInvoicesToWatch, watchClosedInvoice, watchUntil } from "./closed-watch.js";
import {
  depositKeyOf,
  destinationAmount,
  DESTINATION_KINDS,
  feeRateOf,
  storeTransfers,
  STUCK_PAYOUT_MS,
} from "./deposit-payout.js";
import { getPaymentStatus } from "./invoice.function.js";
import { totalOf } from "./payment-ledger.js";
import { acceptedPaymentAmount } from "./payment-rules.js";
import { logStatusChange } from "./status-log.js";
import {
  hintSwapStart,
  maxLossOf,
  minAmountOutOf,
  payIntoSwap,
  quoteRef,
  refundToOf,
  seenDelivery,
  swapRecordFields,
  swapRefOf,
} from "./swap-payout.js";

export type WatcherPorts = {
  now: () => number;
  /** The chain adapters, keyed by deposit asset. */
  chains: ChainRegistry;
  /** The swap provider: swap invoices, and refund routing's swap to the receive coin. */
  swap: SwapPort;
};

/** One look at every open invoice, then at every closed one still watched. */
export async function runWatcherPass(
  ports: WatcherPorts,
  isStopped: () => boolean = () => false,
): Promise<void> {
  // A merchant's-list invoice has no deposit address until the payer picks
  // a coin, so there is nothing on chain to look at: only the clock.
  const now = ports.now();
  await Invoice.updateMany(
    {
      mode: { $in: ["merchant_list", "swap"] },
      crypto: "",
      status: "waiting",
      $expr: {
        $lte: [
          { $add: ["$timestamps.waiting", { $multiply: ["$lifetime", 60_000] }] },
          now,
        ],
      },
    },
    {
      $set: { status: "expired", "timestamps.expired": now, watch_until: watchUntil(now) },
      ...logStatusChange("waiting", "expired", now),
    },
  ).exec();

  // Listed first, so an invoice that closes in this pass is watched from the
  // next one: its deposit was just looked at.
  const closed = await closedInvoicesToWatch(now, depositAssets(ports.chains));

  const invoices = await Invoice.find({
    crypto: { $in: depositAssets(ports.chains) },
    status: {
      $in: ["waiting", "underpaid", "confirming", "confirmed", "processing"],
    },
  })
    .select("invoice_id status crypto -_id")
    .lean()
    .exec();

  for (const invoice of invoices) {
    if (isStopped()) break;
    const adapter = isAssetId(invoice.crypto) ? ports.chains[invoice.crypto] : undefined;
    if (adapter === undefined) continue;

    // One invoice failing must not hold up the others.
    try {
      if (invoice.status === "confirmed" || invoice.status === "processing") {
        await payOut(invoice.invoice_id, adapter, ports);
      } else {
        await checkPayments(invoice.invoice_id, adapter, ports);
      }
    } catch (error) {
      console.error("Invoice watcher failed on", invoice.invoice_id, error);
    }
  }

  for (const invoice of closed) {
    if (isStopped()) break;
    const adapter = isAssetId(invoice.crypto) ? ports.chains[invoice.crypto] : undefined;
    if (adapter === undefined) continue;
    try {
      await watchClosedInvoice(invoice.invoice_id, adapter, ports);
    } catch (error) {
      console.error("Closed-invoice watch failed on", invoice.invoice_id, error);
    }
  }
}

// ---------- Payments ----------

type RecordedPayment = {
  txid: string;
  amount: string;
  first_seen_at: number;
  confirmations: number;
  on_time: boolean;
};

/**
 * The chain's current list, each payment with the earliest time anyone saw
 * it: an earlier pass, this pass, or the provider. A payment the chain no
 * longer shows (replaced before it confirmed) is dropped.
 */
function recordPayments(
  stored: { txid: string; first_seen_at: number }[],
  payments: ChainPayment[],
  now: number,
  expiresAt: number,
): RecordedPayment[] {
  const seenBefore = new Map(stored.map((p) => [p.txid, p.first_seen_at]));
  return payments
    .filter((p) => p.amount > 0n)
    .map((p) => {
      const firstSeenAt = Math.min(
        seenBefore.get(p.txid) ?? now,
        now,
        Number.isFinite(p.seenAt) ? p.seenAt! : now,
      );
      return {
        txid: p.txid,
        amount: p.amount.toString(),
        first_seen_at: firstSeenAt,
        confirmations: p.confirmations,
        on_time: firstSeenAt < expiresAt,
      };
    })
    .sort((a, b) => a.first_seen_at - b.first_seen_at);
}

async function checkPayments(invoiceId: string, adapter: ChainAdapter, ports: WatcherPorts) {
  const invoice = await Invoice.findOne({ invoice_id: invoiceId }).lean().exec();
  if (!invoice) return;

  const currentStatus = invoice.status;
  if (
    currentStatus !== "waiting" &&
    currentStatus !== "underpaid" &&
    currentStatus !== "confirming"
  )
    return;

  const waitingSince = invoice.timestamps?.waiting;
  if (waitingSince == null) {
    console.error("Invoice waiting timestamp is missing", invoiceId);
    return;
  }
  const expiresAt = waitingSince + invoice.lifetime * 60 * 1000;

  // Look before deciding expiry: a payment already there at the expiry
  // check is on time, and a failed lookup must never expire an invoice.
  const listed = await adapter.getPayments(invoice.address);
  if (listed === undefined) return;

  const now = ports.now();
  const payments = recordPayments(invoice.payments ?? [], listed, now, expiresAt);
  const onTime = payments.filter((p) => p.on_time);
  const receivedAmount = onTime.reduce((sum, p) => sum + BigInt(p.amount), 0n);
  const confirmedAmount = onTime
    .filter((p) => p.confirmations >= adapter.requiredConfirmations)
    .reduce((sum, p) => sum + BigInt(p.amount), 0n);

  const paymentStatus = getPaymentStatus({
    requiredAmount: acceptedPaymentAmount(invoice),
    receivedAmount,
    confirmedAmount,
  });

  let newStatus: typeof paymentStatus | "expired" = paymentStatus;
  let outcome: "partially_paid" | undefined;
  if (
    currentStatus !== "confirming" &&
    (paymentStatus === "waiting" || paymentStatus === "underpaid") &&
    now >= expiresAt
  ) {
    //if expired keep the paid_amount
    newStatus = "expired";
    if (receivedAmount > 0n) outcome = "partially_paid";
  }

  const changes: Record<string, unknown> = {
    payments,
    paid_amount: receivedAmount.toString(),
    status: newStatus,
    "tx.in": payments[0]?.txid ?? "",
  };
  if (outcome) changes.outcome = outcome;
  if (
    newStatus !== currentStatus &&
    (newStatus === "confirmed" || newStatus === "confirming" || newStatus === "expired")
  ) {
    changes[`timestamps.${newStatus}`] = now;
  }
  if (newStatus === "expired") changes.watch_until = watchUntil(now);

  const result = await Invoice.updateOne(
    { invoice_id: invoiceId, crypto: invoice.crypto, status: currentStatus },
    { $set: changes, ...(newStatus !== currentStatus && logStatusChange(currentStatus, newStatus, now)) },
  ).exec();
  if (result.matchedCount === 1 && newStatus !== currentStatus) {
    console.log("Invoice status changed:", invoiceId, newStatus);
  }
}

// ---------- Payout ----------

/** What the invoice records when a checkpoint is saved; the old fields too, for the webhook and old readers. */
function checkpointFields(next: PayoutCheckpoint, isSwap: boolean): Record<string, unknown> {
  const { transfers, platformFee, networkCost } = next.plan;
  return {
    "tx.raw": next.state,
    "tx.out": transfers.find((t) => DESTINATION_KINDS.has(t.kind))?.txid ?? "",
    "tx.platform_out": transfers.find((t) => t.kind === "platform_fee")?.txid ?? "",
    transfers: storeTransfers(transfers, "pending"),
    platform_fee: platformFee.toString(),
    network_fee: networkCost.toString(),
    // Swap: what the merchant gets is known only once the delivery is seen.
    received_amount: isSwap ? "0" : destinationAmount(transfers).toString(),
  };
}

type PayoutInvoice = NonNullable<Awaited<ReturnType<typeof findPayoutInvoice>>>;

const PAYING_OUT = { $in: ["confirmed" as const, "processing" as const] };

async function findPayoutInvoice(invoiceId: string) {
  return await Invoice.findOne({ invoice_id: invoiceId, status: PAYING_OUT })
    .select("+private.private_key +tx.raw")
    .exec();
}

/** Paid in one coin, received in another: the money goes through a swap. */
function isSwapInvoice(invoice: { crypto?: string | null; to_crypto?: string | null }): boolean {
  return Boolean(invoice.to_crypto) && invoice.to_crypto !== invoice.crypto;
}

function savedCheckpoint(invoice: PayoutInvoice): PayoutCheckpoint | undefined {
  if (invoice.status !== "processing" || !invoice.tx?.raw) return undefined;
  return {
    state: invoice.tx.raw,
    plan: {
      transfers: (invoice.transfers ?? []).map((t) => ({
        kind: t.kind,
        to: t.to,
        amount: BigInt(t.amount),
        txid: t.txid,
      })),
      platformFee: BigInt(invoice.platform_fee || "0"),
      networkCost: BigInt(invoice.network_fee || "0"),
    },
  };
}

async function payOut(invoiceId: string, adapter: ChainAdapter, ports: WatcherPorts) {
  const invoice = await findPayoutInvoice(invoiceId);
  if (!invoice) return;

  const isSwap = isSwapInvoice(invoice);
  const transfers = invoice.transfers ?? [];
  const proven =
    invoice.status === "processing" &&
    transfers.length > 0 &&
    transfers.every((t) => t.status === "confirmed");

  if (!proven) {
    const checkpoint = savedCheckpoint(invoice);
    if (isSwap && checkpoint === undefined) {
      await startSwap(invoice, adapter, ports);
    } else {
      const result = await requestPayout(invoice, adapter, ports, checkpoint, isSwap);
      const swapRef = invoice.swap?.deposit_address ? swapRefOf(invoice.swap) : undefined;
      await recordPayoutResult(invoice, result.outcome, result.latestPlan, ports, isSwap, swapRef);
    }
  }

  if (isSwap) await followSwap(invoiceId, ports);
}

/** Why a payout can't start, or what it needs: the deposit key and the fee rate. */
async function payoutBasics(invoice: PayoutInvoice) {
  const nothingSent = `Nothing was sent: all funds are still at deposit address ${invoice.address}.`;
  const depositKey = depositKeyOf(invoice);
  if (!depositKey) {
    return `the deposit key is missing from the database. ${nothingSent} Restore the key from backup; without it the funds cannot be moved.`;
  }
  const feeRate = await feeRateOf(invoice);
  if (typeof feeRate === "string") {
    return `${feeRate}. ${nothingSent} Fix the rate, then set the invoice back to "confirmed" to retry.`;
  }
  return { depositKey, feeRate };
}

const stopped = (message: string): PayoutResult => ({ status: "failed", message: `Payout stopped: ${message}`, transfers: [] });

async function requestPayout(
  invoice: PayoutInvoice,
  adapter: ChainAdapter,
  ports: WatcherPorts,
  checkpoint: PayoutCheckpoint | undefined,
  isSwap: boolean,
): Promise<{ outcome: PayoutResult; latestPlan: Transfer[] }> {
  let latestPlan = checkpoint?.plan.transfers ?? [];
  const nothingSent = `Nothing was sent: all funds are still at deposit address ${invoice.address}.`;

  // A swap invoice gets here only with a saved checkpoint: its destination is
  // the swap's deposit address, fixed when the quote was saved.
  const destination = isSwap ? invoice.swap?.deposit_address ?? "" : invoice.to_address;
  const receiveAsset = invoice.to_crypto;
  if (!checkpoint && (receiveAsset !== adapter.asset || !adapter.isValidAddress(destination))) {
    return {
      outcome: stopped(`payout address "${destination}" is not a valid ${receiveAsset} address for a ${adapter.asset} deposit. ${nothingSent} Fix to_address, then set the invoice back to "confirmed" to retry.`),
      latestPlan,
    };
  }

  const basics = await payoutBasics(invoice);
  if (typeof basics === "string") return { outcome: stopped(basics), latestPlan };

  let claimed = checkpoint !== undefined;
  let currentState = checkpoint?.state;
  const request: PayoutRequest = {
    depositAddress: invoice.address,
    depositKey: basics.depositKey,
    destination,
    destinationKind: isSwap ? "swap_deposit" : "merchant_payout",
    receiveAsset: adapter.asset,
    feeRate: basics.feeRate,
    minimumAmount: acceptedPaymentAmount(invoice),
    checkpoint,
    saveCheckpoint: async (next) => {
      const fields = checkpointFields(next, isSwap);
      const result = claimed
        ? await Invoice.updateOne(
            { invoice_id: invoice.invoice_id, status: "processing", "tx.raw": currentState },
            { $set: fields },
          ).exec()
        : await Invoice.updateOne(
            { invoice_id: invoice.invoice_id, status: "confirmed" },
            {
              $set: { ...fields, status: "processing", "timestamps.processing": ports.now() },
              ...logStatusChange("confirmed", "processing", ports.now()),
            },
          ).exec();
      if (result.matchedCount !== 1) {
        console.warn("Another run saved this payout first:", invoice.invoice_id);
        return false;
      }
      claimed = true;
      currentState = next.state;
      latestPlan = next.plan.transfers;
      return true;
    },
  };

  const outcome = await adapter.payout(request);
  return { outcome, latestPlan };
}

// Each quote opens a deposit address at the provider; a payout that keeps
// waiting (fee API down, gas wallet empty) must not open one every pass.
const QUOTE_EVERY_MS = 5 * 60_000;

/** A swap invoice's first payout: quote, then pay exactly the quoted amount into the swap. */
async function startSwap(invoice: PayoutInvoice, adapter: ChainAdapter, ports: WatcherPorts): Promise<void> {
  const now = ports.now();
  if (invoice.swap_quoted_at != null && now - invoice.swap_quoted_at < QUOTE_EVERY_MS) return;
  const claimed = await Invoice.updateOne(
    { invoice_id: invoice.invoice_id, status: "confirmed", swap_quoted_at: invoice.swap_quoted_at ?? null },
    { $set: { swap_quoted_at: now } },
  ).exec();
  if (claimed.matchedCount !== 1) return;

  const nothingSent = `Nothing was sent: all funds are still at deposit address ${invoice.address}.`;
  const stop = async (message: string) => await recordPayoutResult(invoice, stopped(message), [], ports, true);

  const receiveAsset = invoice.to_crypto;
  if (!isAssetId(receiveAsset) || !ports.swap.supports(adapter.asset, receiveAsset)) {
    return await stop(`${adapter.asset} can't be swapped into "${receiveAsset}" by any swap provider. ${nothingSent} Fix to_crypto, then set the invoice back to "confirmed" to retry.`);
  }
  const recipient = invoice.to_address;
  if (checkPayoutAddress(receiveAsset, recipient) !== "valid") {
    return await stop(`payout address "${recipient}" is not a valid ${receiveAsset} address. ${nothingSent} Fix to_address, then set the invoice back to "confirmed" to retry.`);
  }
  const basics = await payoutBasics(invoice);
  if (typeof basics === "string") return await stop(basics);

  let latestPlan: Transfer[] = [];
  const answer = await payIntoSwap({
    adapter,
    swap: ports.swap,
    to: receiveAsset,
    recipient,
    maxLossBps: await maxLossOf(invoice),
    received: totalOf(invoice.payments ?? []),
    request: {
      depositAddress: invoice.address,
      depositKey: basics.depositKey,
      feeRate: basics.feeRate,
      minimumAmount: acceptedPaymentAmount(invoice),
    },
    save: async (next, quote) => {
      const result = await Invoice.updateOne(
        { invoice_id: invoice.invoice_id, status: "confirmed" },
        {
          $set: {
            ...checkpointFields(next, true),
            ...swapRecordFields("swap.", quote, receiveAsset, recipient),
            status: "processing",
            "timestamps.processing": ports.now(),
          },
          $inc: { "swap.version": 1 },
          ...logStatusChange("confirmed", "processing", ports.now()),
        },
      ).exec();
      if (result.matchedCount !== 1) {
        console.warn("Another run saved this swap payout first:", invoice.invoice_id);
        return false;
      }
      latestPlan = next.plan.transfers;
      return true;
    },
  });

  const outcome: PayoutResult =
    answer.kind === "payout"
      ? answer.result
      : answer.kind === "too_small"
        ? { status: "too_small", reason: answer.reason }
        : { status: "pending", reason: answer.reason, ...(answer.review !== undefined && { review: answer.review }) };
  const saved = answer.kind === "payout" && answer.quote ? quoteRef(answer.quote) : undefined;
  await recordPayoutResult(invoice, outcome, latestPlan, ports, true, saved);
}

async function recordPayoutResult(
  invoice: PayoutInvoice,
  result: PayoutResult,
  latestPlan: Transfer[],
  ports: WatcherPorts,
  isSwap: boolean,
  /** The swap the payout pays into, for the provider's deposit hint. */
  swapRef?: SwapRef,
) {
  const invoiceId = invoice.invoice_id;
  const now = ports.now();
  const open = { invoice_id: invoiceId, status: PAYING_OUT };

  switch (result.status) {
    case "pending":
    case "too_small": {
      // Nothing was sent: the money stays at the deposit, marked, and the
      // payout is tried again each pass (more money may arrive).
      if (result.status === "too_small") {
        await Invoice.updateOne(
          { ...open, outcome: { $ne: "too_small_to_forward" } },
          { $set: { outcome: "too_small_to_forward" }, $inc: { outcome_version: 1 } },
        ).exec();
      }
      const processingAt = invoice.status === "processing" ? invoice.timestamps?.processing : null;
      const review =
        result.status === "pending" && result.review
          ? result.review
          : processingAt != null && now - processingAt >= STUCK_PAYOUT_MS
            ? `Payout not finished 24 hours after it was saved (${result.reason}). The funds stay at deposit address ${invoice.address} until it lands. Do not pay the merchant from another wallet: the saved payout can still land.`
            : undefined;
      if (review !== undefined) {
        await Invoice.updateOne({ ...open, review_reason: { $ne: review } }, { $set: { review_reason: review } }).exec();
      }
      console.warn(`Payout ${result.status} (${result.reason}):`, invoiceId);
      return;
    }

    case "paid": {
      const changes: Record<string, unknown> = {
        transfers: storeTransfers(result.transfers, "confirmed"),
        "tx.out": result.transfers.find((t) => DESTINATION_KINDS.has(t.kind))?.txid ?? invoice.tx?.out ?? "",
        "tx.platform_out": result.transfers.find((t) => t.kind === "platform_fee")?.txid ?? "",
        review_reason: result.note ?? "",
      };
      if (isSwap) {
        // The coins reached the swap; its delivery completes the invoice.
        changes.status = "processing";
      } else {
        changes.received_amount = destinationAmount(result.transfers).toString();
        changes.status = "completed";
        changes["timestamps.completed"] = now;
        changes.watch_until = watchUntil(now);
      }
      if (invoice.outcome === "too_small_to_forward") changes.outcome = "";
      const updated = await updatePayingOut(invoice, changes, now);
      if (updated) {
        console.log(isSwap ? "Payout reached the swap:" : "Payout completed:", invoiceId);
        if (result.note) console.warn("Payout note needs review:", invoiceId);
        const deposit = result.transfers.find((t) => t.kind === "swap_deposit");
        if (isSwap && deposit && swapRef?.depositAddress === deposit.to) await hintSwapStart(ports.swap, swapRef, deposit.txid);
      }
      return;
    }

    case "failed": {
      const updated = await updatePayingOut(
        invoice,
        {
          status: "failed",
          "timestamps.failed": now,
          review_reason: result.message,
          transfers: [
            ...storeTransfers(latestPlan, "failed"),
            ...storeTransfers(result.transfers, "confirmed"),
          ],
        },
        now,
      );
      if (!updated) {
        console.warn("Payout failed, but the invoice is no longer open:", invoiceId, result.message);
        return;
      }
      console.error("Payout failed:", invoiceId, result.message);
      return;
    }
  }
}

/**
 * Applies `changes` to a paying-out invoice and logs its status change, if
 * any. The status read earlier may be stale (saving a checkpoint moves it to
 * processing), so each paying-out status is tried, the one read first.
 */
async function updatePayingOut(invoice: PayoutInvoice, changes: Record<string, unknown>, now: number): Promise<boolean> {
  const to = changes.status;
  const tries = invoice.status === "processing" ? (["processing", "confirmed"] as const) : (["confirmed", "processing"] as const);
  for (const from of tries) {
    const logged = typeof to === "string" && to !== from ? logStatusChange(from, to, now) : {};
    const result = await Invoice.updateOne({ invoice_id: invoice.invoice_id, status: from }, { $set: changes, ...logged }).exec();
    if (result.matchedCount === 1) return true;
  }
  return false;
}

// ---------- Following a swap ----------

/** A review note that keeps an earlier late-payment note (see LATE_PAYMENT_NOTE_PREFIX). */
function keepLateNote(current: string | null | undefined, text: string): string {
  const at = (current ?? "").indexOf(LATE_PAYMENT_NOTE_PREFIX);
  const late = at >= 0 ? current!.slice(at) : "";
  return [text, late].filter(Boolean).join(" ");
}

/**
 * Moves a swap invoice on from the provider's status, once the deposit
 * reached the swap. Completed only when the provider reports success and the
 * receive coin's chain shows the delivery at the merchant's address.
 */
async function followSwap(invoiceId: string, ports: WatcherPorts): Promise<void> {
  const invoice = await Invoice.findOne({ invoice_id: invoiceId, status: "processing", "swap.deposit_address": { $gt: "" } })
    .select("+swap.quote_response")
    .lean()
    .exec();
  if (!invoice?.swap) return;
  const transfers = invoice.transfers ?? [];
  if (transfers.length === 0 || !transfers.every((t) => t.status === "confirmed")) return;

  const swap = invoice.swap;
  const depositAddress = swap.deposit_address;
  const reply = await ports.swap.status(swapRefOf(swap));
  if (reply === undefined) return;

  const now = ports.now();
  const filter = {
    invoice_id: invoiceId,
    status: "processing" as const,
    "swap.deposit_address": depositAddress,
    "swap.status": swap.status ?? "",
  };
  const bump = reply.status !== swap.status ? { $inc: { "swap.version": 1 } } : {};
  const coin = invoice.crypto.toUpperCase();
  const refundTo = refundToOf(swap.quote_response) ?? invoice.address;
  const reason = reply.refundReason ?? "no reason given";
  const note = (text: string) => keepLateNote(invoice.review_reason, text);
  const processingAt = invoice.timestamps?.processing;
  const stuck = processingAt != null && now - processingAt >= STUCK_PAYOUT_MS;
  let set: Record<string, unknown>;

  switch (reply.status) {
    case "SUCCESS": {
      const delivery = await seenDelivery({
        chains: ports.chains,
        receiveAsset: invoice.to_crypto,
        recipient: invoice.to_address,
        deliveryTxids: reply.deliveryTxids,
      });
      if (delivery.kind === "unverifiable") {
        set = {
          "swap.status": reply.status,
          "swap.destination_txids": reply.deliveryTxids,
          review_reason: note(`The swap provider reports the swap delivered. ${delivery.reason}.`),
        };
        break;
      }
      if (delivery.kind !== "seen") {
        set = { "swap.status": reply.status, "swap.destination_txids": reply.deliveryTxids };
        if (stuck) {
          set.review_reason = note(`The swap provider reports the swap delivered (${reply.deliveryTxids.join(", ") || "no txid"}), but ${delivery.reason}. Check the merchant's address ${invoice.to_address} on a ${invoice.to_crypto} explorer; the invoice completes once the delivery is seen.`);
        }
        break;
      }
      const minimum = minAmountOutOf(swap);
      const short =
        minimum !== undefined && delivery.amount < minimum
          ? `The merchant's address received ${delivery.amount} (smallest ${invoice.to_crypto} units), below the quote's minimum of ${minimum}. Ask the swap provider (deposit address ${depositAddress}).`
          : "";
      set = {
        "swap.status": reply.status,
        "swap.amount_delivered": delivery.amount.toString(),
        "swap.destination_txids": delivery.txids,
        "swap.amount_refunded": (reply.refundedAmount ?? 0n).toString(),
        status: "completed",
        received_amount: delivery.amount.toString(),
        "timestamps.completed": now,
        watch_until: watchUntil(now),
        review_reason: note(short),
      };
      if (invoice.outcome === "too_small_to_forward") set.outcome = "";
      break;
    }

    case "REFUNDED":
      // The coins go back to refundTo. If that is the deposit, the 7-day
      // watch sees them as new money and refund routing forwards them.
      set = {
        "swap.status": reply.status,
        "swap.amount_refunded": (reply.refundedAmount ?? 0n).toString(),
        "swap.refund_reason": reply.refundReason ?? "",
        status: "failed",
        "timestamps.failed": now,
        watch_until: watchUntil(now),
        review_reason: note(
          refundTo === invoice.address
            ? `Swap refunded: the provider sent ${reply.refundedAmount ?? "the"} ${coin} back to deposit address ${refundTo}. Refund routing forwards it (refund address, payout address, a swap to the receive coin, else held). Provider says: ${reason}`
            : `Swap refunded: the provider sent the ${coin} back to ${refundTo}, not to the deposit address (a swap saved before ticket 15). Pay the merchant by hand from there. Provider says: ${reason}`,
        ),
      };
      break;

    case "FAILED":
      set = {
        "swap.status": reply.status,
        status: "failed",
        "timestamps.failed": now,
        watch_until: watchUntil(now),
        review_reason: note(`Swap failed: ask the swap provider about deposit address ${depositAddress}. Refunds go to ${refundTo}; money that comes back to the deposit within 7 days is routed. Provider says: ${reason}`),
      };
      break;

    case "INCOMPLETE_DEPOSIT":
      set = { "swap.status": reply.status, review_reason: note(`The swap provider received less than quoted at ${depositAddress}; it refunds by the deadline (${swap.deadline}). Investigate.`) };
      break;

    default:
      set = { "swap.status": reply.status };
      if (stuck) {
        set.review_reason = note(`Swap not finished 24 hours after the payout was saved (provider status ${reply.status}, deposit address ${depositAddress}). Ask the swap provider before sending anything.`);
      }
  }

  const result = await Invoice.updateOne(filter, {
    $set: set,
    ...bump,
    ...(typeof set.status === "string" && logStatusChange("processing", set.status, now)),
  }).exec();
  if (result.modifiedCount > 0 && set.status !== undefined) {
    console.log("Swap finished:", invoiceId, reply.status);
  }
}

export function startInvoiceWatcher() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentRun: Promise<void> = Promise.resolve();

  const ports: WatcherPorts = {
    now: Date.now,
    chains: chainAdapters,
    swap: swapProvider,
  };

  async function checkInvoices(): Promise<void> {
    try {
      await runWatcherPass(ports, () => stopped);
    } catch (error) {
      console.error("Invoice watcher failed:", error);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          currentRun = checkInvoices();
        }, 15_000);
      }
    }
  }

  currentRun = checkInvoices();

  return async function stopInvoiceWatcher(): Promise<void> {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    await currentRun;
  };
}
