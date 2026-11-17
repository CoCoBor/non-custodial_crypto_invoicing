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
import { updateSwapStatus } from "../swap/near.js";
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
import { acceptedPaymentAmount } from "./payment-rules.js";

export type WatcherPorts = {
  now: () => number;
  /** The chain adapters, keyed by deposit asset. */
  chains: ChainRegistry;
  /** Legacy NEAR swap: moves a processing swap invoice on from NEAR's status. */
  followSwap: (invoiceId: string) => Promise<void>;
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
      mode: "merchant_list",
      crypto: "",
      status: "waiting",
      $expr: {
        $lte: [
          { $add: ["$timestamps.waiting", { $multiply: ["$lifetime", 60_000] }] },
          now,
        ],
      },
    },
    { $set: { status: "expired", "timestamps.expired": now, watch_until: watchUntil(now) } },
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
      await watchClosedInvoice(invoice.invoice_id, adapter, ports.now());
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
    { $set: changes },
  ).exec();
  if (result.matchedCount === 1 && newStatus !== currentStatus) {
    console.log("Invoice status changed:", invoiceId, newStatus);
  }
}

// ---------- Payout ----------

/** What the invoice records when a checkpoint is saved; the old fields too, for the webhook and old readers. */
function checkpointFields(next: PayoutCheckpoint, isSwap: boolean): Record<string, unknown> {
  const { transfers, platformFee, networkCost, legacySwap } = next.plan;
  return {
    "tx.raw": next.state,
    "tx.out": transfers.find((t) => DESTINATION_KINDS.has(t.kind))?.txid ?? "",
    "tx.platform_out": transfers.find((t) => t.kind === "platform_fee")?.txid ?? "",
    transfers: storeTransfers(transfers, "pending"),
    platform_fee: platformFee.toString(),
    network_fee: networkCost.toString(),
    // Swap: what the merchant gets is known only when NEAR finishes.
    received_amount: isSwap ? "0" : destinationAmount(transfers).toString(),
    ...(legacySwap
      ? {
          "swap.deposit_address": legacySwap.depositAddress,
          "swap.deadline": legacySwap.deadline,
          "swap.status": "PENDING_DEPOSIT",
          "swap.quote_response": legacySwap.quote ?? null,
        }
      : {}),
  };
}

type PayoutInvoice = NonNullable<Awaited<ReturnType<typeof findPayoutInvoice>>>;

const PAYING_OUT = { $in: ["confirmed" as const, "processing" as const] };

async function findPayoutInvoice(invoiceId: string) {
  return await Invoice.findOne({ invoice_id: invoiceId, status: PAYING_OUT })
    .select("+private.private_key +tx.raw")
    .exec();
}

function savedCheckpoint(invoice: PayoutInvoice): PayoutCheckpoint | undefined {
  if (invoice.status !== "processing" || !invoice.tx?.raw) return undefined;
  const swap = invoice.swap;
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
      ...(swap?.deposit_address
        ? { legacySwap: { depositAddress: swap.deposit_address, deadline: swap.deadline ?? "" } }
        : {}),
    },
  };
}

function isValidDestination(adapter: ChainAdapter, receiveAsset: string, destination: string): boolean {
  if (receiveAsset === adapter.asset) return adapter.isValidAddress(destination);
  return (
    isAssetId(receiveAsset) &&
    adapter.canPayOutAs(receiveAsset) &&
    checkPayoutAddress(receiveAsset, destination) === "valid"
  );
}

async function payOut(invoiceId: string, adapter: ChainAdapter, ports: WatcherPorts) {
  const invoice = await findPayoutInvoice(invoiceId);
  if (!invoice) return;

  const isSwap = invoice.to_crypto !== invoice.crypto;
  const transfers = invoice.transfers ?? [];
  const proven =
    invoice.status === "processing" &&
    transfers.length > 0 &&
    transfers.every((t) => t.status === "confirmed");

  if (!proven) {
    const result = await requestPayout(invoice, adapter, ports, isSwap);
    await recordPayoutResult(invoice, result.outcome, result.latestPlan, ports.now(), isSwap);
  }

  if (isSwap) await ports.followSwap(invoiceId);
}

async function requestPayout(
  invoice: PayoutInvoice,
  adapter: ChainAdapter,
  ports: WatcherPorts,
  isSwap: boolean,
): Promise<{ outcome: PayoutResult; latestPlan: Transfer[] }> {
  const checkpoint = savedCheckpoint(invoice);
  let latestPlan = checkpoint?.plan.transfers ?? [];
  const nothingSent = `Nothing was sent: all funds are still at deposit address ${invoice.address}.`;
  const stop = (message: string) => ({
    outcome: { status: "failed" as const, message: `Payout stopped: ${message}`, transfers: [] },
    latestPlan,
  });

  const destination = invoice.to_address;
  const receiveAsset = invoice.to_crypto;
  if (!checkpoint && !isValidDestination(adapter, receiveAsset, destination)) {
    return stop(`payout address "${destination}" is not a valid ${receiveAsset} address for a ${adapter.asset} deposit. ${nothingSent} Fix to_address, then set the invoice back to "confirmed" to retry.`);
  }

  const depositKey = depositKeyOf(invoice);
  if (!depositKey) {
    return stop(`the deposit key is missing from the database. ${nothingSent} Restore the key from backup; without it the funds cannot be moved.`);
  }

  const feeRate = await feeRateOf(invoice);
  if (typeof feeRate === "string") {
    return stop(`${feeRate}. ${nothingSent} Fix the rate, then set the invoice back to "confirmed" to retry.`);
  }

  let claimed = checkpoint !== undefined;
  let currentState = checkpoint?.state;
  const request: PayoutRequest = {
    depositAddress: invoice.address,
    depositKey,
    destination,
    destinationKind: "merchant_payout",
    receiveAsset: isAssetId(receiveAsset) ? receiveAsset : adapter.asset,
    feeRate,
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
            { $set: { ...fields, status: "processing", "timestamps.processing": ports.now() } },
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

async function recordPayoutResult(
  invoice: PayoutInvoice,
  result: PayoutResult,
  latestPlan: Transfer[],
  now: number,
  isSwap: boolean,
) {
  const invoiceId = invoice.invoice_id;
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
        // The coins reached NEAR; NEAR's status completes the invoice.
        changes.status = "processing";
      } else {
        changes.received_amount = destinationAmount(result.transfers).toString();
        changes.status = "completed";
        changes["timestamps.completed"] = now;
        changes.watch_until = watchUntil(now);
        if (invoice.outcome === "too_small_to_forward") changes.outcome = "";
      }
      const updated = await Invoice.updateOne(open, { $set: changes }).exec();
      if (updated.matchedCount === 1) {
        console.log(isSwap ? "Payout reached the swap:" : "Payout completed:", invoiceId);
        if (result.note) console.warn("Payout note needs review:", invoiceId);
      }
      return;
    }

    case "failed": {
      const updated = await Invoice.updateOne(open, {
        $set: {
          status: "failed",
          "timestamps.failed": now,
          review_reason: result.message,
          transfers: [
            ...storeTransfers(latestPlan, "failed"),
            ...storeTransfers(result.transfers, "confirmed"),
          ],
        },
      }).exec();
      if (updated.matchedCount === 0) {
        console.warn("Payout failed, but the invoice is no longer open:", invoiceId, result.message);
        return;
      }
      console.error("Payout failed:", invoiceId, result.message);
      return;
    }
  }
}

async function followNearSwap(invoiceId: string): Promise<void> {
  const current = await Invoice.findOne({ invoice_id: invoiceId, status: "processing" })
    .select("tx.out swap.deposit_address -_id")
    .lean()
    .exec();
  if (current?.tx?.out && current.swap?.deposit_address) {
    await updateSwapStatus(invoiceId, current.tx.out, current.swap.deposit_address);
  }
}

export function startInvoiceWatcher() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentRun: Promise<void> = Promise.resolve();

  const ports: WatcherPorts = {
    now: Date.now,
    chains: chainAdapters,
    followSwap: followNearSwap,
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
