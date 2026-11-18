import { checkPayoutAddress, isAssetId, type AssetId } from "../assets/payout-address.js";
import type {
  ChainAdapter,
  ChainPayment,
  ChainRegistry,
  PayoutCheckpoint,
  PayoutRequest,
  PayoutResult,
  Transfer,
} from "../chains/adapter.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { splitPayout } from "../money/payout-split.js";
import { LATE_PAYMENT_NOTE_PREFIX } from "../swap/near.js";
import type { SwapPort, SwapRef } from "../swap/swap-port.js";
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
import {
  hintSwapStart,
  maxLossOf,
  payIntoSwap,
  quoteRef,
  refundToOf,
  seenDelivery,
  swapRecord,
  swapRefOf,
} from "./swap-payout.js";
import { ROUTE_GRACE_MS } from "./watch-window.js";

export { watchUntil } from "./watch-window.js";

// The 7-day watch of a closed invoice's deposit, and refund routing: money
// that is not the merchant's payout (partial money at expiry, money after a
// cancel, expiry or completion) goes, F1 fees taken, to the merchant's refund
// address, else their payout address, else it is held for a person. The rules
// are in docs/domain.md ("Refund routing").

// "failed" is watched only when it set watch_until: a refunded swap, whose
// coins come back to the deposit. A failed payout leaves it null.
const CLOSED = ["expired", "cancelled", "completed", "failed"] as const;

// A closed deposit is looked at this often (a route in flight every pass):
// each look is a chain lookup, and late money is not urgent.
const LOOK_EVERY_MS = 5 * 60_000;

// A route's states. processing: its payout is saved and not proven yet;
// swapping: the deposit reached the swap provider, whose delivery is awaited.
const IN_FLIGHT: readonly string[] = ["processing", "swapping"];
// Every state in which the route's payout took the money from the deposit.
const SWEPT: readonly string[] = ["paid", "swapping", "refunded"];

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
      { "refund_routes.state": { $in: ["processing", "swapping"] } },
    ],
  })
    .select("invoice_id crypto -_id")
    .lean()
    .exec();
}

type StoredSwap = {
  provider?: string | null;
  provider_swap_id?: string | null;
  deposit_address: string;
  recipient: string;
  receive_crypto: string;
  status: string;
  deadline?: string | null;
  /** In the deposit coin. */
  amount_in?: string | null;
  /** In the deposit coin; "0" when the provider named none (Exolix). */
  amount_refunded?: string | null;
  quote_response?: unknown;
};

type StoredRoute = {
  n: number;
  destination: string;
  source: "refund_address" | "payout_address" | "swap_to_receive_coin";
  state: "processing" | "swapping" | "paid" | "refunded" | "failed";
  raw?: string;
  swept?: string;
  platform_fee?: string;
  network_fee?: string;
  started_at: number;
  swap?: StoredSwap | null;
};

type Destination =
  | { destination: string; source: "refund_address" | "payout_address" }
  /** The spec's last step before "held": swap it into the merchant's receive coin. */
  | { source: "swap_to_receive_coin"; to: AssetId; recipient: string };

type ClosedInvoice = {
  invoice_id: string;
  user_id: string;
  status: (typeof CLOSED)[number];
  outcome: string;
  address: string;
  crypto: string;
  to_crypto?: string | null;
  /** The merchant payout's swap, for a swap invoice. */
  swap?: StoredSwap | null;
  swap_max_loss_bps?: number | null;
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

export type ClosedWatchPorts = { now: () => number; chains: ChainRegistry; swap: SwapPort };

/** One pass's view of a closed invoice; `version` follows this run's own writes. */
type Watch = {
  invoice: ClosedInvoice;
  adapter: ChainAdapter;
  ports: ClosedWatchPorts;
  now: number;
  version: number;
  payments: LedgerPayment[];
};

async function loadClosed(invoiceId: string): Promise<ClosedInvoice | undefined> {
  const found = await Invoice.findOne({ invoice_id: invoiceId, status: { $in: CLOSED } })
    .select("+private.private_key +refund_routes.raw +swap.quote_response")
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
export async function watchClosedInvoice(invoiceId: string, adapter: ChainAdapter, ports: ClosedWatchPorts): Promise<void> {
  const invoice = await loadClosed(invoiceId);
  if (!invoice || invoice.watch_done) return;

  const now = ports.now();
  const inFlight = invoice.refund_routes.find((r) => IN_FLIGHT.includes(r.state));
  const graceOver = now >= invoice.watch_until + ROUTE_GRACE_MS;
  const watch: Watch = { invoice, adapter, ports, now, version: invoice.watch_version ?? 0, payments: invoice.payments };

  if (!graceOver || inFlight) {
    const listed = await adapter.getPayments(invoice.address);
    if (listed !== undefined) {
      watch.payments = mergePayments(invoice.payments, listed, now, invoice.watch_until);
    } else if (!inFlight) {
      return;
    }
  }
  watch.payments = assignPayments(watch.payments, sweepsOf(invoice));

  if (inFlight) return inFlight.state === "swapping" ? await followRouteSwap(watch, inFlight) : await followRoute(watch, inFlight);

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
  const sent = invoice.transfers.filter(
    (t) => (t.payout ?? 0) === 0 && t.status === "confirmed" && DESTINATION_KINDS.has(t.kind),
  );
  // A refunded swap's invoice is failed, but its payout swept the deposit too.
  if (invoice.status === "completed" || sent.length > 0) {
    sweeps.push({
      payout: 0,
      swept:
        sent.reduce((sum, t) => sum + BigInt(t.amount), 0n) +
        BigInt(invoice.platform_fee || "0") +
        BigInt(invoice.network_fee || "0"),
    });
  }
  for (const route of invoice.refund_routes) {
    if (SWEPT.includes(route.state)) sweeps.push({ payout: route.n, swept: BigInt(route.swept || "0") });
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

// ---------- Money that already paid its fee ----------

const amountOf = (text: string | null | undefined) => (text && /^[0-9]+$/.test(text) ? BigInt(text) : 0n);

/**
 * What a swap of this deposit sent back to it: on a refund or failure all it
 * took in (or less, when the provider names a smaller refund); on success the
 * part the provider names as refunded. That money paid its platform fee when
 * it went into the swap.
 */
function cameBack(swap: StoredSwap | null | undefined): bigint {
  if (!swap) return 0n;
  const amountIn = amountOf(swap.amount_in);
  const refunded = amountOf(swap.amount_refunded);
  switch (swap.status) {
    case "REFUNDED":
    case "FAILED":
      return refunded > 0n && refunded < amountIn ? refunded : amountIn;
    case "SUCCESS":
      return refunded < amountIn ? refunded : amountIn;
    default:
      return 0n;
  }
}

/**
 * The money at the deposit that route `n` forwards with no platform fee: what
 * swaps sent back (the merchant payout's swap, and earlier fallback swaps),
 * less what earlier routes already forwarded fee-free. The fee is charged once
 * on every piece of money (owner decision 2026-11-19); money that never paid
 * it still does. Counted as amounts, not payments: a refund can't be told
 * apart from new money on chain.
 */
function feePaidMoney(invoice: ClosedInvoice, n: number): bigint {
  // A swap saved before ticket 15 refunded elsewhere, not to this deposit.
  const main = invoice.swap && refundToOf(invoice.swap.quote_response) === invoice.address ? cameBack(invoice.swap) : 0n;
  let left = main;
  for (const route of [...invoice.refund_routes].sort((a, b) => a.n - b.n)) {
    if (route.n >= n) break;
    if (SWEPT.includes(route.state)) {
      // From its transfers, not its stored `swept`, which leaves out a swap deposit.
      const sentOn = invoice.transfers
        .filter((t) => t.payout === route.n && DESTINATION_KINDS.has(t.kind))
        .reduce((sum, t) => sum + BigInt(t.amount), 0n);
      const taken = sentOn + amountOf(route.platform_fee) + amountOf(route.network_fee);
      left -= taken < left ? taken : left;
    }
    left += cameBack(route.swap);
  }
  return left;
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

  // Swap it into the receive coin, unless a swap to it already came back:
  // the money of a refunded fallback swap is held, never swapped again.
  const to = invoice.to_crypto ?? "";
  const swapCameBack = invoice.refund_routes.some(
    (r) => r.source === "swap_to_receive_coin" && (r.state === "refunded" || r.state === "failed"),
  );
  if (!isAssetId(to) || to === adapter.asset || swapCameBack) return undefined;
  if (!watch.ports.swap.supports(adapter.asset, to) || watch.ports.chains[to] === undefined) return undefined;
  const recipient = merchant?.payout_addresses?.[to];
  if (!recipient || checkPayoutAddress(to, recipient) !== "valid") return undefined;
  return { source: "swap_to_receive_coin", to, recipient };
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
        `Held for manual handling: ${money} is at deposit address ${invoice.address}, and the merchant has no valid ${adapter.asset} refund or payout address${invoice.to_crypto && invoice.to_crypto !== adapter.asset ? ` (and no swap to ${invoice.to_crypto} can be made${invoice.refund_routes.some((r) => r.source === "swap_to_receive_coin" && r.state === "refunded") ? ": a swap of this money was already refunded" : ""})` : ""}. If the merchant sets one before ${until}, the watcher forwards it; otherwise forward it by hand with the deposit key.`,
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

  const n = nextRouteNumber(invoice);
  const feeExempt = feePaidMoney(invoice, n);
  if (destination.source === "swap_to_receive_coin") {
    return await startSwapRoute(watch, ready, destination, depositKey, feeRate, feeExempt);
  }

  // F1 with the expected network cost first; the chain's own dust or rent
  // limit is the adapter's too_small below.
  const estimate = await adapter.estimateNetworkCost();
  if (typeof estimate === "bigint" && splitPayout({ received: totalOf(ready), networkCost: estimate, feeRate, feeExempt }) === undefined) {
    return await save(watch, { outcome: "too_small_to_forward" });
  }

  const route = routeRequest(watch, { n, ...destination }, undefined, depositKey, feeRate, feeExempt);
  const result = await adapter.payout(route.request);
  await recordRouteResult(watch, route, result);
}

function nextRouteNumber(invoice: ClosedInvoice): number {
  return Math.max(0, ...invoice.refund_routes.map((r) => r.n)) + 1;
}

/** Refund routing's last step: quote a swap into the receive coin and pay exactly that into it. */
async function startSwapRoute(
  watch: Watch,
  ready: LedgerPayment[],
  destination: Extract<Destination, { source: "swap_to_receive_coin" }>,
  depositKey: PayoutRequest["depositKey"],
  feeRate: bigint,
  feeExempt: bigint,
): Promise<void> {
  const { invoice, adapter } = watch;
  const n = nextRouteNumber(invoice);
  const saver = routeSaver(watch, { n }, undefined);
  const answer = await payIntoSwap({
    adapter,
    swap: watch.ports.swap,
    to: destination.to,
    recipient: destination.recipient,
    maxLossBps: await maxLossOf(invoice),
    received: totalOf(ready),
    request: { depositAddress: invoice.address, depositKey, feeRate, feeExempt, minimumAmount: 1n },
    save: async (next, quote) =>
      await saver.save(next, {
        destination: quote.depositAddress,
        source: "swap_to_receive_coin",
        swap: { ...swapRecord(quote, destination.to, destination.recipient), version: 1, notified_version: 0 },
      }),
  });

  if (answer.kind === "too_small") return await save(watch, { outcome: "too_small_to_forward" });
  if (answer.kind === "wait") {
    console.warn(`Refund route ${n} swap waiting (${answer.reason}):`, invoice.invoice_id);
    return await save(watch, {
      outcome: baseOutcome(watch),
      ...(answer.review !== undefined ? { review_reason: withLateNote(invoice, answer.review) } : {}),
    });
  }
  const run: RouteRun = {
    route: {
      n,
      destination: answer.quote?.depositAddress ?? destination.recipient,
      source: "swap_to_receive_coin",
      ...(answer.quote ? { swapRef: quoteRef(answer.quote) } : {}),
    },
    ...saver,
  };
  await recordRouteResult(watch, run, answer.result);
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
  const route = routeRequest(watch, stored, checkpoint, depositKey, feeRate, feePaidMoney(invoice, stored.n));
  const result = await watch.adapter.payout(route.request);
  await recordRouteResult(watch, route, result);
}

type RouteFields = {
  destination: string;
  source: StoredRoute["source"];
  /** The route's swap record, for a swap to the receive coin. */
  swap?: Record<string, unknown>;
};

type RouteSaver = {
  /** Saves the route's checkpoint; the first save pushes the route with `first`. */
  save: (next: PayoutCheckpoint, first: RouteFields) => Promise<boolean>;
  /** True once a checkpoint of this route is in the database. */
  saved: () => boolean;
  latestPlan: () => Transfer[];
  swept: () => bigint;
};

type RouteRun = Omit<RouteSaver, "save"> & {
  route: {
    n: number;
    destination: string;
    source: StoredRoute["source"];
    started_at?: number;
    /** A swap route's swap, when it was quoted in this run. */
    swapRef?: SwapRef;
  };
};

function routeSaver(
  watch: Watch,
  route: { n: number; swept?: string | undefined },
  checkpoint: PayoutCheckpoint | undefined,
): RouteSaver {
  const { invoice } = watch;
  let claimed = checkpoint !== undefined;
  let currentState = checkpoint?.state;
  let latestPlan = checkpoint?.plan.transfers ?? [];
  let swept = BigInt(route.swept || "0");

  const save = async (next: PayoutCheckpoint, first: RouteFields): Promise<boolean> => {
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
                destination: first.destination,
                source: first.source,
                state: "processing",
                raw: next.state,
                ...amounts,
                started_at: watch.now,
                settled_at: null,
                notified: false,
                ...(first.swap ? { swap: first.swap } : {}),
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
  };

  return { save, saved: () => claimed, latestPlan: () => latestPlan, swept: () => swept };
}

function routeRequest(
  watch: Watch,
  route: { n: number; destination: string; source: StoredRoute["source"]; started_at?: number; swept?: string },
  checkpoint: PayoutCheckpoint | undefined,
  depositKey: PayoutRequest["depositKey"],
  feeRate: bigint,
  feeExempt: bigint,
): RouteRun & { request: PayoutRequest } {
  const saver = routeSaver(watch, route, checkpoint);
  const request: PayoutRequest = {
    depositAddress: watch.invoice.address,
    depositKey,
    destination: route.destination,
    destinationKind: route.source === "swap_to_receive_coin" ? "swap_deposit" : "refund_route",
    receiveAsset: watch.adapter.asset,
    feeRate,
    feeExempt,
    // Forward whatever the deposit holds: a fixed minimum could never be met
    // once a storage fee (TON) has taken part of it.
    minimumAmount: 1n,
    checkpoint,
    saveCheckpoint: async (next) => await saver.save(next, { destination: route.destination, source: route.source }),
  };
  return { request, route, saved: saver.saved, latestPlan: saver.latestPlan, swept: saver.swept };
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
      // A swap route's deposit reached the provider: it is paid once delivered.
      const isSwap = run.route.source === "swap_to_receive_coin";
      const updated = await Invoice.updateOne(
        {
          invoice_id: invoice.invoice_id,
          ...versionIs(watch.version),
          refund_routes: { $elemMatch: { n, state: "processing" } },
        },
        {
          $set: {
            ...(isSwap ? { "refund_routes.$.state": "swapping" } : { "refund_routes.$.state": "paid", "refund_routes.$.settled_at": now }),
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
        console.log(isSwap ? "Refund route reached the swap:" : "Refund route paid:", invoice.invoice_id, n);
        const deposit = result.transfers.find((t) => t.kind === "swap_deposit");
        const storedSwap = invoice.refund_routes.find((r) => r.n === n)?.swap;
        const swapRef = run.route.swapRef ?? (storedSwap?.deposit_address ? swapRefOf(storedSwap) : undefined);
        if (isSwap && deposit && swapRef?.depositAddress === deposit.to) await hintSwapStart(watch.ports.swap, swapRef, deposit.txid);
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

/** A route whose deposit reached the swap: moves it on from the provider's status. */
async function followRouteSwap(watch: Watch, stored: StoredRoute): Promise<void> {
  const { invoice, now } = watch;
  const swap = stored.swap;
  if (!swap?.deposit_address) {
    return await save(watch, {
      review_reason: withLateNote(invoice, `Refund route ${stored.n} reached a swap but has no swap record (a bug or a manual DB edit). Check deposit address ${invoice.address} and the swap provider before sending anything.`),
    });
  }
  const reply = await watch.ports.swap.status(swapRefOf(swap));
  if (reply === undefined) return await save(watch, {});

  const p = "refund_routes.$.";
  const stuck = now - stored.started_at >= STUCK_PAYOUT_MS;
  let set: Record<string, unknown> = { [`${p}swap.status`]: reply.status };
  let outcome = baseOutcome(watch);
  let review: string | undefined;
  let held = false;

  switch (reply.status) {
    case "SUCCESS": {
      set[`${p}swap.destination_txids`] = reply.deliveryTxids;
      const delivery = await seenDelivery({
        chains: watch.ports.chains,
        receiveAsset: swap.receive_crypto,
        recipient: swap.recipient,
        deliveryTxids: reply.deliveryTxids,
      });
      if (delivery.kind === "unverifiable") {
        review = `Refund route ${stored.n}: the swap provider reports the swap delivered. ${delivery.reason}.`;
        break;
      }
      if (delivery.kind !== "seen") {
        if (stuck) review = `Refund route ${stored.n}: the swap provider reports the swap delivered, but ${delivery.reason}. Check ${swap.recipient} on a ${swap.receive_crypto} explorer.`;
        break;
      }
      set = {
        ...set,
        [`${p}state`]: "paid",
        [`${p}settled_at`]: now,
        [`${p}swap.amount_delivered`]: delivery.amount.toString(),
        [`${p}swap.destination_txids`]: delivery.txids,
        [`${p}swap.amount_refunded`]: (reply.refundedAmount ?? 0n).toString(),
      };
      break;
    }
    case "REFUNDED":
      // The coins come back to the deposit as new money; refundDestination
      // will not swap them again.
      set = {
        ...set,
        [`${p}state`]: "refunded",
        [`${p}settled_at`]: now,
        [`${p}swap.amount_refunded`]: (reply.refundedAmount ?? 0n).toString(),
        [`${p}swap.refund_reason`]: reply.refundReason ?? "",
      };
      break;
    case "FAILED":
      held = true;
      outcome = "held_for_manual_handling";
      set = { ...set, [`${p}state`]: "failed", [`${p}settled_at`]: now };
      review = `Held for manual handling: refund route ${stored.n}'s swap failed. Ask the swap provider about deposit address ${swap.deposit_address}; refunds go to deposit address ${invoice.address}. Provider says: ${reply.refundReason ?? "no reason given"}`;
      break;
    default:
      if (stuck) review = `Refund route ${stored.n}'s swap not finished 24 hours after it was saved (provider status ${reply.status}, deposit address ${swap.deposit_address}). Ask the swap provider before sending anything.`;
  }

  const updated = await Invoice.updateOne(
    {
      invoice_id: invoice.invoice_id,
      ...versionIs(watch.version),
      refund_routes: { $elemMatch: { n: stored.n, state: "swapping" } },
    },
    {
      $set: {
        ...set,
        payments: watch.payments,
        watch_checked_at: now,
        ...changesWithOutcome(watch, outcome),
        ...(review !== undefined ? { review_reason: withLateNote(invoice, review) } : {}),
        ...(held ? { watch_done: true } : {}),
      },
      $inc: {
        watch_version: 1,
        ...outcomeBump(watch, outcome),
        ...(reply.status !== swap.status ? { [`${p}swap.version`]: 1 } : {}),
      },
    },
  ).exec();
  if (updated.matchedCount === 1) watch.version += 1;
}

// ---------- Ending the watch ----------

async function finish(watch: Watch): Promise<void> {
  const { invoice } = watch;
  const left = stillAtDeposit(watch.payments);
  if (left.length === 0) return await save(watch, { watch_done: true, outcome: baseOutcome(watch) });
  const ended = `the 7-day watch ended (${new Date(invoice.watch_until).toISOString()})`;
  // Dust is held too (owner decision 2026-11-19): the payer did pay it, and no
  // second payment may ever come to lift it over the fees.
  const why =
    invoice.outcome === "too_small_to_forward"
      ? `${ended} with ${describeMoney(watch, left)} too small to forward: the fees and network cost would take it all.`
      : `${ended} with ${describeMoney(watch, left)} not forwarded.`;
  await save(watch, {
    watch_done: true,
    outcome: "held_for_manual_handling",
    review_reason: withLateNote(
      invoice,
      `Held for manual handling: ${why} It should still be at deposit address ${invoice.address}; forward it by hand with the deposit key.`,
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
