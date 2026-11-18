import { createHmac } from "node:crypto";

import { Invoice } from "../database/invoices.model.js";
import { askedAmount } from "../invoice/payment-rules.js";
import { lockedRateView, priceView, type LockedRate } from "../invoice/pricing.js";
import { swapView, type StoredSwapRecord } from "../invoice/swap-view.js";
import { User } from "../database/users.model.js";
import { WebhookEvent } from "../database/webhook-event.model.js";
import { openSecret } from "../security/secret-envelope.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };

export type WebhookPorts = {
  now: () => number;
  isAllowedDestination: (url: URL) => Promise<boolean>;
  post: typeof fetch;
};

// Waits after failed attempts 1-4; the 5th failure gives up.
const RETRY_DELAYS_MS = [1, 5, 30, 120].map((minutes) => minutes * 60_000);
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * Records new invoice statuses, outcome changes, paid refund routes and swap
 * status changes as events, then sends the events that are due.
 */
export async function runWebhookPass(ports: WebhookPorts): Promise<void> {
  const now = ports.now();
  await recordStatusChanges(now);
  await recordOutcomeChanges(now);
  await recordRefundRoutes(now);
  await recordSwapChanges(now);
  await recordRefundRouteSwapChanges(now);
  await deliverDueEvents(ports);
}

/**
 * The id status events had before they were numbered. Still used for the first
 * change found on an invoice written before status_log existed, so an event
 * recorded by the old code just before a deploy is not recorded twice.
 */
export function statusEventId(invoiceId: string, from: string, to: string): string {
  return `${invoiceId}:${from}->${to}`;
}

/** The n-th status event of an invoice, counted from 1. */
export function numberedStatusEventId(invoiceId: string, n: number): string {
  return `${invoiceId}:status:${n}`;
}

/**
 * One event per outcome change made without a status change. An outcome can
 * come back (too small, forwarded, too small again), so its id is the
 * invoice's outcome_version, which counts every such change.
 */
export function outcomeEventId(invoiceId: string, outcomeVersion: number): string {
  return `${invoiceId}:outcome:${outcomeVersion}`;
}

/** One event per refund route, once it is paid. */
export function refundRouteEventId(invoiceId: string, route: number): string {
  return `${invoiceId}:refund_route:${route}`;
}

/** One event per swap status change, counted by the swap's version. */
export function swapEventId(invoiceId: string, swapVersion: number): string {
  return `${invoiceId}:swap:${swapVersion}`;
}

/** One event per status change of a refund route's swap (the fallback swap to the receive coin). */
export function refundRouteSwapEventId(invoiceId: string, route: number, swapVersion: number): string {
  return `${invoiceId}:refund_route:${route}:swap:${swapVersion}`;
}

const SWAP_FIELDS = [
  "provider",
  "deposit_address",
  "recipient",
  "receive_crypto",
  "status",
  "deadline",
  "amount_in",
  "min_amount_out",
  "amount_delivered",
  "amount_refunded",
  "refund_reason",
  "destination_txids",
  "version",
  "notified_version",
]
  .map((field) => `swap.${field}`)
  .join(" ");

const INVOICE_FIELDS =
  `invoice_id user_id status notified_status status_log notified_status_log status_event_count outcome outcome_version notified_outcome_version crypto to_crypto amount asked_amount fee_paid_by_payer currency amount_fiat locked_rate paid_amount platform_fee network_fee received_amount tx.in tx.out tx.platform_out payments transfers ${SWAP_FIELDS} -_id`;

type InvoiceSummary = {
  invoice_id: string;
  status?: string | null;
  outcome?: string | null;
  crypto?: string | null;
  to_crypto?: string | null;
  amount: string;
  asked_amount?: string | null;
  fee_paid_by_payer?: boolean | null;
  currency?: string | null;
  amount_fiat: string;
  locked_rate?: Partial<LockedRate> | null;
  paid_amount?: string | null;
  platform_fee?: string | null;
  network_fee?: string | null;
  received_amount?: string | null;
  tx?: { in?: string | null; out?: string | null; platform_out?: string | null } | null;
  swap?: StoredSwapRecord | null;
  payments?: { txid: string; amount: string; first_seen_at: number; on_time: boolean }[] | null;
  transfers?: { kind: string; txid: string; amount: string; status: string }[] | null;
};

// A token deposit's gas top-up, and the sweep of its unused gas, are in its chain's own coin.
function transferAsset(kind: string, depositAsset: string): string {
  if (kind !== "gas_top_up" && kind !== "gas_sweep") return depositAsset;
  return cryptos[depositAsset as keyof typeof cryptos]?.chain.symbol ?? depositAsset;
}

function invoiceBody(invoice: InvoiceSummary) {
  return {
    invoiceId: invoice.invoice_id,
    status: invoice.status ?? "",
    outcome: invoice.outcome ?? "",
    crypto: invoice.crypto,
    toCrypto: invoice.to_crypto,
    amount: invoice.amount,
    askedAmount: askedAmount(invoice).toString(),
    feePaidByPayer: invoice.fee_paid_by_payer ?? false,
    amountFiat: invoice.amount_fiat,
    price: priceView(invoice),
    lockedRate: lockedRateView(invoice.locked_rate),
    paidAmount: invoice.paid_amount,
    platformFee: invoice.platform_fee,
    networkFee: invoice.network_fee,
    merchantAmount: invoice.received_amount,
    txids: {
      in: invoice.tx?.in ?? "",
      out: invoice.tx?.out ?? "",
      platformOut: invoice.tx?.platform_out ?? "",
    },
    swap: swapView(invoice.swap),
    payments: (invoice.payments ?? []).map((p) => ({
      txid: p.txid,
      amount: p.amount,
      firstSeenAt: new Date(p.first_seen_at).toISOString(),
      onTime: p.on_time,
    })),
    transfers: (invoice.transfers ?? []).map((t) => ({
      kind: t.kind,
      txid: t.txid,
      amount: t.amount,
      asset: transferAsset(t.kind, invoice.crypto ?? ""),
      status: t.status,
    })),
  };
}

async function hasWebhook(userId: string): Promise<boolean> {
  const merchant = await User.findOne({ user_id: userId }).select("webhook_url").lean().exec();
  return Boolean(merchant?.webhook_url);
}

// Recording the same event id twice is a no-op, so a crash between recording
// an event and marking it announced can't lose or duplicate it.
async function recordEvent(event: {
  eventId: string;
  userId: string;
  invoiceId: string;
  status: string;
  payload: Record<string, unknown>;
  now: number;
}): Promise<void> {
  await WebhookEvent.updateOne(
    { eventId: event.eventId },
    {
      $setOnInsert: {
        eventId: event.eventId,
        userId: event.userId,
        invoiceId: event.invoiceId,
        status: event.status,
        payload: JSON.stringify({
          ...event.payload,
          occurredAt: new Date(event.now).toISOString(),
        }),
        attempts: 0,
        nextAttemptAt: new Date(event.now),
        deliveredAt: null,
        failedAt: null,
        lastError: "",
      },
    },
    { upsert: true },
  ).exec();
}

type StatusChange = { from: string; to: string; logged: boolean };

/**
 * The status changes not announced yet, in order. Code that changes a status
 * logs it in the same update (status_log); a change the log can't explain
 * (an operator's database edit, or one made before the log existed) shows as
 * a jump between two entries, or between the last one and the status.
 */
function unannouncedChanges(invoice: {
  status?: string | null;
  notified_status?: string | null;
  status_log?: { from: string; to: string }[] | null;
  notified_status_log?: number | null;
}): StatusChange[] {
  const changes: StatusChange[] = [];
  let reached = invoice.notified_status ?? "";
  for (const entry of (invoice.status_log ?? []).slice(invoice.notified_status_log ?? 0)) {
    if (entry.from !== reached) changes.push({ from: reached, to: entry.from, logged: false });
    changes.push({ from: entry.from, to: entry.to, logged: true });
    reached = entry.to;
  }
  const status = invoice.status ?? "";
  if (status !== reached) changes.push({ from: reached, to: status, logged: false });
  return changes;
}

const countIs = (count: number | null | undefined) => (count ? count : { $in: [0, null] });

// Each change gets its own event, numbered in order. The events are recorded
// before they are marked announced, and the same log always gives the same
// ids, so a crash in between can't lose or duplicate one.
async function recordStatusChanges(now: number): Promise<void> {
  const changed = await Invoice.find({
    $expr: {
      $or: [
        { $ne: ["$status", { $ifNull: ["$notified_status", ""] }] },
        { $gt: [{ $size: { $ifNull: ["$status_log", []] } }, { $ifNull: ["$notified_status_log", 0] }] },
      ],
    },
  })
    .select(INVOICE_FIELDS)
    .lean()
    .exec();

  for (const invoice of changed) {
    const webhook = await hasWebhook(invoice.user_id);
    let n = invoice.status_event_count ?? 0;
    for (const change of unannouncedChanges(invoice)) {
      n += 1;
      if (!webhook) continue;
      const eventId =
        !change.logged && n === 1
          ? statusEventId(invoice.invoice_id, change.from, change.to)
          : numberedStatusEventId(invoice.invoice_id, n);
      await recordEvent({
        eventId,
        userId: invoice.user_id,
        invoiceId: invoice.invoice_id,
        status: change.to,
        payload: { event: "invoice.status_changed", eventId, ...invoiceBody(invoice), status: change.to },
        now,
      });
    }

    await Invoice.updateOne(
      {
        invoice_id: invoice.invoice_id,
        notified_status: invoice.notified_status ?? null,
        notified_status_log: countIs(invoice.notified_status_log),
        status_event_count: countIs(invoice.status_event_count),
      },
      {
        $set: {
          notified_status: invoice.status ?? "",
          notified_status_log: invoice.status_log?.length ?? 0,
          status_event_count: n,
        },
      },
    ).exec();
  }
}

// Outcomes that change with the status (expired, partially paid) ride on the
// status event; the watcher bumps outcome_version only for the others.
async function recordOutcomeChanges(now: number): Promise<void> {
  const changed = await Invoice.find({
    $expr: {
      $gt: [{ $ifNull: ["$outcome_version", 0] }, { $ifNull: ["$notified_outcome_version", 0] }],
    },
  })
    .select(INVOICE_FIELDS)
    .lean()
    .exec();

  for (const invoice of changed) {
    const version = invoice.outcome_version ?? 0;
    if (await hasWebhook(invoice.user_id)) {
      const eventId = outcomeEventId(invoice.invoice_id, version);
      await recordEvent({
        eventId,
        userId: invoice.user_id,
        invoiceId: invoice.invoice_id,
        status: invoice.status ?? "",
        payload: { event: "invoice.outcome_changed", eventId, ...invoiceBody(invoice) },
        now,
      });
    }
    await Invoice.updateOne(
      { invoice_id: invoice.invoice_id },
      { $max: { notified_outcome_version: version } },
    ).exec();
  }
}

async function recordRefundRoutes(now: number): Promise<void> {
  const invoices = await Invoice.find({
    refund_routes: { $elemMatch: { state: "paid", notified: { $ne: true } } },
  })
    .select("invoice_id user_id status outcome crypto refund_routes transfers payments -_id")
    .lean()
    .exec();

  for (const invoice of invoices) {
    const webhook = await hasWebhook(invoice.user_id);
    for (const route of invoice.refund_routes ?? []) {
      if (route.state !== "paid" || route.notified) continue;
      const transfers = (invoice.transfers ?? []).filter((t) => t.payout === route.n);
      if (webhook) {
        const eventId = refundRouteEventId(invoice.invoice_id, route.n);
        await recordEvent({
          eventId,
          userId: invoice.user_id,
          invoiceId: invoice.invoice_id,
          status: invoice.status ?? "",
          payload: {
            event: "invoice.refund_routed",
            eventId,
            invoiceId: invoice.invoice_id,
            status: invoice.status ?? "",
            outcome: invoice.outcome ?? "",
            crypto: invoice.crypto,
            refundRoute: {
              number: route.n,
              destination: route.destination,
              destinationSource: route.source,
              amount: transfers
                .filter((t) => t.kind === "refund_route" || t.kind === "swap_deposit")
                .reduce((sum, t) => sum + BigInt(t.amount), 0n)
                .toString(),
              platformFee: route.platform_fee,
              networkFee: route.network_fee,
              txids: [...new Set(transfers.map((t) => t.txid))],
              payments: (invoice.payments ?? [])
                .filter((p) => p.payout === route.n)
                .map((p) => ({ txid: p.txid, amount: p.amount, onTime: p.on_time })),
              swap: swapView(route.swap),
            },
          },
          now,
        });
      }
      await Invoice.updateOne(
        { invoice_id: invoice.invoice_id, refund_routes: { $elemMatch: { n: route.n, notified: { $ne: true } } } },
        { $set: { "refund_routes.$.notified": true } },
      ).exec();
    }
  }
}

const swapChanged = (path: string) => ({
  $gt: [{ $ifNull: [`${path}.version`, 0] }, { $ifNull: [`${path}.notified_version`, 0] }],
});

// The watcher bumps swap.version on each provider status change it saves
// (and once when the swap is quoted). Two changes between passes are
// announced once, with the latest state, under the latest version.
async function recordSwapChanges(now: number): Promise<void> {
  const changed = await Invoice.find({ $expr: swapChanged("$swap") }).select(INVOICE_FIELDS).lean().exec();

  for (const invoice of changed) {
    const version = invoice.swap?.version ?? 0;
    if (await hasWebhook(invoice.user_id)) {
      const eventId = swapEventId(invoice.invoice_id, version);
      await recordEvent({
        eventId,
        userId: invoice.user_id,
        invoiceId: invoice.invoice_id,
        status: invoice.status ?? "",
        payload: { event: "invoice.swap_changed", eventId, ...invoiceBody(invoice) },
        now,
      });
    }
    await Invoice.updateOne({ invoice_id: invoice.invoice_id }, { $max: { "swap.notified_version": version } }).exec();
  }
}

async function recordRefundRouteSwapChanges(now: number): Promise<void> {
  const invoices = await Invoice.find({
    $expr: {
      $anyElementTrue: [{ $map: { input: { $ifNull: ["$refund_routes", []] }, as: "r", in: swapChanged("$$r.swap") } }],
    },
  })
    .select("invoice_id user_id status outcome crypto refund_routes -_id")
    .lean()
    .exec();

  for (const invoice of invoices) {
    const webhook = await hasWebhook(invoice.user_id);
    for (const route of invoice.refund_routes ?? []) {
      const version = route.swap?.version ?? 0;
      if (version <= (route.swap?.notified_version ?? 0)) continue;
      if (webhook) {
        const eventId = refundRouteSwapEventId(invoice.invoice_id, route.n, version);
        await recordEvent({
          eventId,
          userId: invoice.user_id,
          invoiceId: invoice.invoice_id,
          status: invoice.status ?? "",
          payload: {
            event: "invoice.refund_route_swap_changed",
            eventId,
            invoiceId: invoice.invoice_id,
            status: invoice.status ?? "",
            outcome: invoice.outcome ?? "",
            crypto: invoice.crypto,
            refundRoute: {
              number: route.n,
              state: route.state,
              destination: route.destination,
              destinationSource: route.source,
              platformFee: route.platform_fee,
              networkFee: route.network_fee,
              swap: swapView(route.swap),
            },
          },
          now,
        });
      }
      await Invoice.updateOne(
        { invoice_id: invoice.invoice_id, "refund_routes.n": route.n },
        { $max: { "refund_routes.$.swap.notified_version": version } },
      ).exec();
    }
  }
}

async function deliverDueEvents(ports: WebhookPorts): Promise<void> {
  const now = ports.now();
  const due = await WebhookEvent.find({
    deliveredAt: null,
    failedAt: null,
    nextAttemptAt: { $lte: new Date(now) },
  })
    .sort({ nextAttemptAt: 1, _id: 1 })
    .limit(100)
    .lean()
    .exec();

  for (const event of due) {
    const problem = await deliver(event, ports, now);
    const attempts = event.attempts + 1;

    if (problem === undefined) {
      await WebhookEvent.updateOne(
        { eventId: event.eventId },
        { $set: { deliveredAt: new Date(now), attempts, lastError: "" } },
      ).exec();
      continue;
    }

    const changes =
      attempts >= MAX_ATTEMPTS
        ? { failedAt: new Date(now) }
        : { nextAttemptAt: new Date(now + RETRY_DELAYS_MS[attempts - 1]!) };
    await WebhookEvent.updateOne(
      { eventId: event.eventId },
      { $set: { ...changes, attempts, lastError: problem } },
    ).exec();
  }
}

/** undefined when the merchant's server took the event, otherwise why not. */
async function deliver(
  event: { userId: string; payload: string },
  ports: WebhookPorts,
  now: number,
): Promise<string | undefined> {
  const merchant = await User.findOne({ user_id: event.userId })
    .select("webhook_url +webhook_secret")
    .exec();
  if (!merchant?.webhook_url || !merchant.webhook_secret) {
    return "the merchant has no webhook URL or secret";
  }
  const { keyVersion, initialisationVector, authenticationTag, ciphertext } =
    merchant.webhook_secret;

  let url: URL;
  try {
    url = new URL(merchant.webhook_url);
  } catch {
    return "the webhook URL is not valid";
  }
  if (!(await ports.isAllowedDestination(url))) {
    return "the webhook destination is not allowed";
  }

  const secret = openSecret("webhook-secret", {
    keyVersion,
    initialisationVector,
    authenticationTag,
    ciphertext,
  });
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${event.payload}`)
    .digest("hex");

  try {
    const response = await ports.post(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": `sha256=${signature}`,
      },
      body: event.payload,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? undefined : `the merchant's server answered ${response.status}`;
  } catch {
    return "the merchant's server could not be reached";
  }
}
