import type {
  ChainAdapter,
  ChainPayment,
  PayoutCheckpoint,
  PayoutRequest,
  PayoutResult,
  Transfer,
} from "../chains/adapter.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { splitPayout } from "../money/payout-split.js";
import { LATE_PAYMENT_NOTE_PREFIX } from "../swap/near.js";
import {
  depositKeyOf,
  destinationAmount,
  DESTINATION_KINDS,
  feeRateOf,
  storeTransfers,
  STUCK_PAYOUT_MS,
  type StoredTransfer,
} from "./deposit-payout.js";
import {
  assignPayments,
  readyToRoute,
  stillAtDeposit,
  totalOf,
  type LedgerPayment,
  type Sweep,
} from "./payment-ledger.js";
import { ROUTE_GRACE_MS } from "./watch-window.js";

export { watchUntil } from "./watch-window.js";

// The 7-day watch of a closed invoice's deposit, and refund routing: money
// that is not the merchant's payout (partial money at expiry, money after a
// cancel, expiry or completion) goes, F1 fees taken, to the merchant's refund
// address, else their payout address, else it is held for a person. The rules
// are in docs/domain.md ("Refund routing").

const CLOSED = ["expired", "cancelled", "completed"] as const;

// A closed deposit is looked at this often (a route in flight every pass):
// each look is a chain lookup, and late money is not urgent.
const LOOK_EVERY_MS = 5 * 60_000;

/** Closed invoices whose deposit is due a look. */
export async function closedInvoicesToWatch(now: number, assets: string[]) {
  return await Invoice.find({
    crypto: { $in: assets },
    status: { $in: CLOSED },
    watch_until: { $ne: null },
    watch_done: { $ne: true },
    $or: [
      { watch_checked_at: null },
      { watch_checked_at: { $lte: now - LOOK_EVERY_MS } },
      { "refund_routes.state": "processing" },
    ],
  })
    .select("invoice_id crypto -_id")
    .lean()
    .exec();
}

type StoredRoute = {
  n: number;
  destination: string;
  source: "refund_address" | "payout_address";
  state: "processing" | "paid" | "failed";
  raw?: string;
  swept?: string;
  platform_fee?: string;
  network_fee?: string;
  started_at: number;
};

type Destination = { destination: string; source: StoredRoute["source"] };

type ClosedInvoice = {
  invoice_id: string;
  user_id: string;
  status: (typeof CLOSED)[number];
  outcome: string;
  address: string;
  fee_rate?: string | null;
  platform_fee?: string | null;
  network_fee?: string | null;
  review_reason?: string | null;
  watch_until: number;
  watch_done?: boolean | null;
  watch_version?: number | null;
  payments: LedgerPayment[];
  transfers: StoredTransfer[];
  refund_routes: StoredRoute[];
  depositKey: PayoutRequest["depositKey"] | undefined;
};

/** One pass's view of a closed invoice; `version` follows this run's own writes. */
type Watch = {
  invoice: ClosedInvoice;
  adapter: ChainAdapter;
  now: number;
  version: number;
  payments: LedgerPayment[];
};

async function loadClosed(invoiceId: string): Promise<ClosedInvoice | undefined> {
  const found = await Invoice.findOne({ invoice_id: invoiceId, status: { $in: CLOSED } })
    .select("+private.private_key +refund_routes.raw")
    .exec();
  if (!found) return undefined;
  // From the document itself: toObject() hands back the key's bytes as BSON
  // Binary, which Buffer.from turns into an empty buffer.
  const depositKey = depositKeyOf(found);
  const invoice = found.toObject() as unknown as ClosedInvoice;
  if (invoice.watch_until == null) return undefined;
  return {
    ...invoice,
    depositKey,
    outcome: invoice.outcome ?? "",
    payments: (invoice.payments ?? []).map((p) => ({ ...p })),
    transfers: (invoice.transfers ?? []).map((t) => ({ ...t })),
    refund_routes: (invoice.refund_routes ?? []).map((r) => ({ ...r })),
  };
}

/** One look at a closed invoice's deposit: record, account, route, or finish. */
export async function watchClosedInvoice(invoiceId: string, adapter: ChainAdapter, now: number): Promise<void> {
  const invoice = await loadClosed(invoiceId);
  if (!invoice || invoice.watch_done) return;

  const inFlight = invoice.refund_routes.find((r) => r.state === "processing");
  const graceOver = now >= invoice.watch_until + ROUTE_GRACE_MS;
  const watch: Watch = { invoice, adapter, now, version: invoice.watch_version ?? 0, payments: invoice.payments };

  if (!graceOver || inFlight) {
    const listed = await adapter.getPayments(invoice.address);
    if (listed !== undefined) {
      watch.payments = mergePayments(invoice.payments, listed, now, invoice.watch_until);
    } else if (!inFlight) {
      return;
    }
  }
  watch.payments = assignPayments(watch.payments, sweepsOf(invoice));

  if (inFlight) return await followRoute(watch, inFlight);

  const ready = readyToRoute(watch.payments, adapter.requiredConfirmations);
  if (ready.length > 0 && !graceOver) return await startRoute(watch, ready);

  const pastWindow = now >= invoice.watch_until;
  if (pastWindow && (graceOver || stillAtDeposit(watch.payments).length === 0)) return await finish(watch);

  await save(watch, { outcome: baseOutcome(watch) });
}

// ---------- Payments and what swept them ----------

/**
 * The chain's list merged into what is recorded. A payment recorded only now,
 * after the invoice closed, is late (on_time false) whatever the provider's
 * time: it can no longer count toward the invoice. One first seen after the
 * watch ended is not recorded. A payment a payout carried stays recorded even if
 * the chain stops listing it; one still at the deposit that the chain no
 * longer lists was replaced, and is dropped.
 */
function mergePayments(
  stored: LedgerPayment[],
  listed: ChainPayment[],
  now: number,
  watchEnd: number,
): LedgerPayment[] {
  const storedById = new Map(stored.map((p) => [p.txid, p]));
  const listedIds = new Set<string>();
  const merged: LedgerPayment[] = [];

  for (const payment of listed) {
    if (payment.amount <= 0n) continue;
    listedIds.add(payment.txid);
    const seenAt = Number.isFinite(payment.seenAt) ? payment.seenAt! : now;
    const earlier = storedById.get(payment.txid);
    if (earlier) {
      merged.push({
        ...earlier,
        confirmations: payment.confirmations,
        first_seen_at: Math.min(earlier.first_seen_at, now, seenAt),
      });
      continue;
    }
    const firstSeenAt = Math.min(now, seenAt);
    if (firstSeenAt >= watchEnd) continue;
    merged.push({
      txid: payment.txid,
      amount: payment.amount.toString(),
      first_seen_at: firstSeenAt,
      confirmations: payment.confirmations,
      on_time: false,
    });
  }
  for (const earlier of stored) {
    if (!listedIds.has(earlier.txid) && earlier.payout != null) merged.push(earlier);
  }
  return merged.sort((a, b) => a.first_seen_at - b.first_seen_at);
}

/** Every proven payout of this deposit and what it swept: destination, platform fee and network cost. */
function sweepsOf(invoice: ClosedInvoice): Sweep[] {
  const sweeps: Sweep[] = [];
  if (invoice.status === "completed") {
    const sent = invoice.transfers.filter(
      (t) => (t.payout ?? 0) === 0 && t.status === "confirmed" && DESTINATION_KINDS.has(t.kind),
    );
    sweeps.push({
      payout: 0,
      swept:
        sent.reduce((sum, t) => sum + BigInt(t.amount), 0n) +
        BigInt(invoice.platform_fee || "0") +
        BigInt(invoice.network_fee || "0"),
    });
  }
  for (const route of invoice.refund_routes) {
    if (route.state === "paid") sweeps.push({ payout: route.n, swept: BigInt(route.swept || "0") });
  }
  return sweeps;
}

function sweptBy(plan: PayoutCheckpoint["plan"]): bigint {
  return destinationAmount(plan.transfers) + plan.platformFee + plan.networkCost;
}

/** The outcome when nothing needs a person: "expired, partially paid" stays. */
function baseOutcome(watch: Watch): string {
  return watch.invoice.status === "expired" && watch.payments.some((p) => p.on_time) ? "partially_paid" : "";
}

// ---------- Where the money goes ----------

async function refundDestination(watch: Watch): Promise<Destination | undefined> {
  const { invoice, adapter } = watch;
  const merchant = await User.findOne({ user_id: invoice.user_id })
    .select("refund_addresses payout_addresses")
    .lean()
    .exec();
  const usable = (address: string | undefined) =>
    Boolean(address) && adapter.isValidAddress(address!) && address !== invoice.address;

  const refund = merchant?.refund_addresses?.[adapter.asset];
  if (usable(refund)) return { destination: refund!, source: "refund_address" };
  const payout = merchant?.payout_addresses?.[adapter.asset];
  if (usable(payout)) return { destination: payout!, source: "payout_address" };
  // The spec's next step, a swap to the merchant's receive coin (ticket 15),
  // goes here, before the money is held.
  return undefined;
}

function describeMoney(watch: Watch, payments: LedgerPayment[]): string {
  const txids = payments.map((p) => p.txid).join(", ");
  return `${totalOf(payments)} (smallest ${watch.adapter.asset} units) from payment(s) ${txids}`;
}

// ---------- Starting and following a route ----------

async function startRoute(watch: Watch, ready: LedgerPayment[]): Promise<void> {
  const { invoice, adapter } = watch;
  const money = describeMoney(watch, ready);
  const until = new Date(invoice.watch_until).toISOString();

  const destination = await refundDestination(watch);
  if (!destination) {
    return await save(watch, {
      outcome: "held_for_manual_handling",
      review_reason: withLateNote(
        invoice,
        `Held for manual handling: ${money} is at deposit address ${invoice.address}, and the merchant has no valid ${adapter.asset} refund or payout address. If the merchant sets one before ${until}, the watcher forwards it; otherwise forward it by hand with the deposit key.`,
      ),
    });
  }
  const depositKey = invoice.depositKey;
  if (!depositKey) {
    return await save(watch, {
      outcome: "held_for_manual_handling",
      review_reason: withLateNote(invoice, `Held for manual handling: the deposit key is missing, so ${money} at deposit address ${invoice.address} can't be moved. Restore the key from backup.`),
    });
  }
  const feeRate = await feeRateOf(invoice);
  if (typeof feeRate === "string") {
    return await save(watch, {
      outcome: "held_for_manual_handling",
      review_reason: withLateNote(invoice, `Held for manual handling: ${feeRate}. ${money} is still at deposit address ${invoice.address}. Fix the rate and the watcher forwards it.`),
    });
  }

  // F1 with the expected network cost first; the chain's own dust or rent
  // limit is the adapter's too_small below.
  const estimate = await adapter.estimateNetworkCost();
  if (typeof estimate === "bigint" && splitPayout({ received: totalOf(ready), networkCost: estimate, feeRate }) === undefined) {
    return await save(watch, { outcome: "too_small_to_forward" });
  }

  const n = Math.max(0, ...invoice.refund_routes.map((r) => r.n)) + 1;
  const route = routeRequest(watch, { n, ...destination }, undefined, depositKey, feeRate);
  const result = await adapter.payout(route.request);
  await recordRouteResult(watch, route, result);
}

async function followRoute(watch: Watch, stored: StoredRoute): Promise<void> {
  const { invoice } = watch;
  const depositKey = invoice.depositKey;
  const feeRate = await feeRateOf(invoice);
  if (!depositKey || typeof feeRate === "string") {
    return await save(watch, {
      review_reason: withLateNote(invoice, `Refund route ${stored.n} is saved but can't be followed: ${depositKey ? feeRate : "the deposit key is missing"}. Its transaction may still land; check deposit address ${invoice.address} on an explorer before sending anything.`),
    });
  }
  const checkpoint: PayoutCheckpoint = {
    state: stored.raw ?? "",
    plan: {
      transfers: invoice.transfers
        .filter((t) => t.payout === stored.n)
        .map((t) => ({ kind: t.kind, to: t.to, amount: BigInt(t.amount), txid: t.txid })),
      platformFee: BigInt(stored.platform_fee || "0"),
      networkCost: BigInt(stored.network_fee || "0"),
    },
  };
  const route = routeRequest(watch, stored, checkpoint, depositKey, feeRate);
  const result = await watch.adapter.payout(route.request);
  await recordRouteResult(watch, route, result);
}

type RouteRun = {
  request: PayoutRequest;
  route: Destination & { n: number; started_at?: number };
  /** True once a checkpoint of this route is in the database. */
  saved: () => boolean;
  latestPlan: () => Transfer[];
  swept: () => bigint;
};

function routeRequest(
  watch: Watch,
  route: Destination & { n: number; started_at?: number; swept?: string },
  checkpoint: PayoutCheckpoint | undefined,
  depositKey: PayoutRequest["depositKey"],
  feeRate: bigint,
): RouteRun {
  const { invoice } = watch;
  let claimed = checkpoint !== undefined;
  let currentState = checkpoint?.state;
  let latestPlan = checkpoint?.plan.transfers ?? [];
  let swept = BigInt(route.swept || "0");

  const request: PayoutRequest = {
    depositAddress: invoice.address,
    depositKey,
    destination: route.destination,
    destinationKind: "refund_route",
    receiveAsset: watch.adapter.asset,
    feeRate,
    // Forward whatever the deposit holds: a fixed minimum could never be met
    // once a storage fee (TON) has taken part of it.
    minimumAmount: 1n,
    checkpoint,
    saveCheckpoint: async (next) => {
      const nextSwept = sweptBy(next.plan);
      const planned = storeTransfers(next.plan.transfers, "pending", route.n);
      const amounts = {
        swept: nextSwept.toString(),
        platform_fee: next.plan.platformFee.toString(),
        network_fee: next.plan.networkCost.toString(),
      };
      const result = claimed
        ? await Invoice.updateOne(
            {
              invoice_id: invoice.invoice_id,
              ...versionIs(watch.version),
              refund_routes: { $elemMatch: { n: route.n, state: "processing", raw: currentState } },
            },
            {
              $set: {
                "refund_routes.$.raw": next.state,
                "refund_routes.$.swept": amounts.swept,
                "refund_routes.$.platform_fee": amounts.platform_fee,
                "refund_routes.$.network_fee": amounts.network_fee,
                transfers: [...invoice.transfers.filter((t) => t.payout !== route.n), ...planned],
              },
              $inc: { watch_version: 1 },
            },
          ).exec()
        : await Invoice.updateOne(
            {
              invoice_id: invoice.invoice_id,
              status: invoice.status,
              watch_done: { $ne: true },
              ...versionIs(watch.version),
              "refund_routes.n": { $ne: route.n },
            },
            {
              $push: {
                refund_routes: {
                  n: route.n,
                  destination: route.destination,
                  source: route.source,
                  state: "processing",
                  raw: next.state,
                  ...amounts,
                  started_at: watch.now,
                  settled_at: null,
                  notified: false,
                },
                transfers: { $each: planned },
              },
              $set: { payments: watch.payments },
              $inc: { watch_version: 1 },
            },
          ).exec();
      if (result.matchedCount !== 1) {
        console.warn("Another run saved this refund route first:", invoice.invoice_id, route.n);
        return false;
      }
      watch.version += 1;
      claimed = true;
      currentState = next.state;
      latestPlan = next.plan.transfers;
      swept = nextSwept;
      return true;
    },
  };

  return {
    request,
    route,
    saved: () => claimed,
    latestPlan: () => latestPlan,
    swept: () => swept,
  };
}

async function recordRouteResult(watch: Watch, run: RouteRun, result: PayoutResult): Promise<void> {
  const { invoice, now } = watch;
  const { n } = run.route;
  const startedAt = run.route.started_at;
  const following = startedAt !== undefined;

  switch (result.status) {
    case "pending": {
      const review =
        result.review ??
        (following && now - startedAt >= STUCK_PAYOUT_MS
          ? `Refund route ${n} not finished 24 hours after it was saved (${result.reason}). The funds stay at deposit address ${invoice.address} until it lands. Do not send them from another wallet: the saved route can still land.`
          : undefined);
      console.warn(`Refund route ${n} pending (${result.reason}):`, invoice.invoice_id);
      return await save(watch, {
        ...(following ? {} : { outcome: baseOutcome(watch) }),
        ...(review !== undefined ? { review_reason: withLateNote(invoice, review) } : {}),
      });
    }

    case "too_small":
      // Starting: nothing was sent and the money stays, marked. Following (a
      // rebuild found less than before): the saved route can still land.
      return await save(watch, following ? {} : { outcome: "too_small_to_forward" });

    case "paid": {
      if (!run.saved()) {
        console.error("Refund route reported paid without a saved checkpoint:", invoice.invoice_id, n);
        return await save(watch, {
          review_reason: withLateNote(invoice, `Refund route ${n} reported paid without a saved checkpoint (an adapter bug). Check deposit address ${invoice.address} on an explorer.`),
        });
      }
      const sweeps = [
        ...sweepsOf(invoice).filter((s) => s.payout !== n),
        { payout: n, swept: run.swept() },
      ];
      watch.payments = assignPayments(watch.payments, sweeps);
      const updated = await Invoice.updateOne(
        {
          invoice_id: invoice.invoice_id,
          ...versionIs(watch.version),
          refund_routes: { $elemMatch: { n, state: "processing" } },
        },
        {
          $set: {
            "refund_routes.$.state": "paid",
            "refund_routes.$.settled_at": now,
            transfers: [
              ...invoice.transfers.filter((t) => t.payout !== n),
              ...storeTransfers(result.transfers, "confirmed", n),
            ],
            payments: watch.payments,
            watch_checked_at: now,
            ...changesWithOutcome(watch, baseOutcome(watch)),
            ...(result.note ? { review_reason: withLateNote(invoice, result.note) } : {}),
          },
          $inc: { watch_version: 1, ...outcomeBump(watch, baseOutcome(watch)) },
        },
      ).exec();
      if (updated.matchedCount === 1) {
        watch.version += 1;
        console.log("Refund route paid:", invoice.invoice_id, n);
      }
      return;
    }

    case "failed": {
      const failedTransfers = [
        ...storeTransfers(run.latestPlan(), "failed", n),
        ...storeTransfers(result.transfers, "confirmed", n),
      ];
      const held = {
        ...changesWithOutcome(watch, "held_for_manual_handling"),
        review_reason: withLateNote(invoice, result.message),
        watch_done: true,
        payments: watch.payments,
        watch_checked_at: now,
      };
      const inc = { watch_version: 1, ...outcomeBump(watch, "held_for_manual_handling") };
      const updated = run.saved()
        ? await Invoice.updateOne(
            {
              invoice_id: invoice.invoice_id,
              ...versionIs(watch.version),
              refund_routes: { $elemMatch: { n, state: "processing" } },
            },
            {
              $set: {
                "refund_routes.$.state": "failed",
                "refund_routes.$.settled_at": now,
                transfers: [...invoice.transfers.filter((t) => t.payout !== n), ...failedTransfers],
                ...held,
              },
              $inc: inc,
            },
          ).exec()
        : await Invoice.updateOne(
            { invoice_id: invoice.invoice_id, ...versionIs(watch.version), "refund_routes.n": { $ne: n } },
            {
              $push: {
                refund_routes: {
                  n,
                  destination: run.route.destination,
                  source: run.route.source,
                  state: "failed",
                  started_at: now,
                  settled_at: now,
                  notified: false,
                },
                transfers: { $each: failedTransfers },
              },
              $set: held,
              $inc: inc,
            },
          ).exec();
      if (updated.matchedCount === 1) watch.version += 1;
      console.error("Refund route failed:", invoice.invoice_id, n, result.message);
      return;
    }
  }
}

// ---------- Ending the watch ----------

async function finish(watch: Watch): Promise<void> {
  const { invoice } = watch;
  const left = stillAtDeposit(watch.payments);
  if (left.length === 0) return await save(watch, { watch_done: true, outcome: baseOutcome(watch) });
  if (invoice.outcome === "too_small_to_forward") return await save(watch, { watch_done: true });
  await save(watch, {
    watch_done: true,
    outcome: "held_for_manual_handling",
    review_reason: withLateNote(
      invoice,
      `Held for manual handling: the 7-day watch ended (${new Date(invoice.watch_until).toISOString()}) with ${describeMoney(watch, left)} not forwarded. It should still be at deposit address ${invoice.address}; forward it by hand with the deposit key.`,
    ),
  });
}

// ---------- Saving ----------

// Invoices that closed before watch_version existed have no such field.
function versionIs(version: number) {
  return { watch_version: version === 0 ? { $in: [0, null] } : version };
}

function changesWithOutcome(watch: Watch, outcome: string): Record<string, unknown> {
  return outcome === watch.invoice.outcome ? {} : { outcome };
}

// The status does not change here, so the status webhook can't carry an
// outcome change: each one gets its own version and webhook.
function outcomeBump(watch: Watch, outcome: string): Record<string, number> {
  return outcome === watch.invoice.outcome ? {} : { outcome_version: 1 };
}

async function save(watch: Watch, changes: { outcome?: string; [field: string]: unknown }): Promise<void> {
  const { outcome, ...rest } = changes;
  const result = await Invoice.updateOne(
    { invoice_id: watch.invoice.invoice_id, status: watch.invoice.status, ...versionIs(watch.version) },
    {
      $set: {
        payments: watch.payments,
        watch_checked_at: watch.now,
        ...rest,
        ...(outcome === undefined ? {} : changesWithOutcome(watch, outcome)),
      },
      $inc: { watch_version: 1, ...(outcome === undefined ? {} : outcomeBump(watch, outcome)) },
    },
  ).exec();
  if (result.matchedCount === 1) {
    watch.version += 1;
  } else {
    console.warn("Closed-invoice watch: another run changed the invoice first:", watch.invoice.invoice_id);
  }
}

/** A review note that keeps an earlier late-payment note (see LATE_PAYMENT_NOTE_PREFIX). */
function withLateNote(invoice: ClosedInvoice, text: string): string {
  const current = invoice.review_reason ?? "";
  const at = current.indexOf(LATE_PAYMENT_NOTE_PREFIX);
  const late = at >= 0 && !text.startsWith(LATE_PAYMENT_NOTE_PREFIX) ? current.slice(at) : "";
  return [text, late].filter(Boolean).join(" ");
}
