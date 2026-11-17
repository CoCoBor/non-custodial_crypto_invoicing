import { createHmac } from "node:crypto";

import { Invoice } from "../database/invoices.model.js";
import { askedAmount } from "../invoice/payment-rules.js";
import { User } from "../database/users.model.js";
import { WebhookEvent } from "../database/webhook-event.model.js";
import { openSecret } from "../security/secret-envelope.js";

export type WebhookPorts = {
  now: () => number;
  isAllowedDestination: (url: URL) => Promise<boolean>;
  post: typeof fetch;
};

// Waits after failed attempts 1-4; the 5th failure gives up.
const RETRY_DELAYS_MS = [1, 5, 30, 120].map((minutes) => minutes * 60_000);
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * Records new invoice statuses, outcome changes and paid refund routes as
 * events, then sends the events that are due.
 */
export async function runWebhookPass(ports: WebhookPorts): Promise<void> {
  const now = ports.now();
  await recordStatusChanges(now);
  await recordOutcomeChanges(now);
  await recordRefundRoutes(now);
  await deliverDueEvents(ports);
}

/** One event per status change; the same change always gets the same id. */
export function statusEventId(invoiceId: string, from: string, to: string): string {
  return `${invoiceId}:${from}->${to}`;
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

const INVOICE_FIELDS =
  "invoice_id user_id status notified_status outcome outcome_version notified_outcome_version crypto to_crypto amount asked_amount fee_paid_by_payer amount_fiat paid_amount platform_fee network_fee received_amount tx.in tx.out tx.platform_out -_id";

type InvoiceSummary = {
  invoice_id: string;
  status?: string | null;
  outcome?: string | null;
  crypto?: string | null;
  to_crypto?: string | null;
  amount: string;
  asked_amount?: string | null;
  fee_paid_by_payer?: boolean | null;
  amount_fiat: string;
  paid_amount?: string | null;
  platform_fee?: string | null;
  network_fee?: string | null;
  received_amount?: string | null;
  tx?: { in?: string | null; out?: string | null; platform_out?: string | null } | null;
};

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
    paidAmount: invoice.paid_amount,
    platformFee: invoice.platform_fee,
    networkFee: invoice.network_fee,
    merchantAmount: invoice.received_amount,
    txids: {
      in: invoice.tx?.in ?? "",
      out: invoice.tx?.out ?? "",
      platformOut: invoice.tx?.platform_out ?? "",
    },
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

// An invoice's status can be changed by many parts of the code; comparing it
// with the last status announced catches every change in one place. Two
// changes between passes are announced once, with the latest status.
// The event is recorded before the change is marked announced, and recording
// it twice is a no-op, so a crash in between can't lose it.
async function recordStatusChanges(now: number): Promise<void> {
  const changed = await Invoice.find({
    $expr: { $ne: ["$status", { $ifNull: ["$notified_status", ""] }] },
  })
    .select(INVOICE_FIELDS)
    .lean()
    .exec();

  for (const invoice of changed) {
    const from = invoice.notified_status ?? "";
    const to = invoice.status ?? "";

    if (await hasWebhook(invoice.user_id)) {
      const eventId = statusEventId(invoice.invoice_id, from, to);
      await recordEvent({
        eventId,
        userId: invoice.user_id,
        invoiceId: invoice.invoice_id,
        status: to,
        payload: { event: "invoice.status_changed", eventId, ...invoiceBody(invoice) },
        now,
      });
    }

    await Invoice.updateOne(
      {
        invoice_id: invoice.invoice_id,
        status: invoice.status,
        notified_status: invoice.notified_status ?? null,
      },
      { $set: { notified_status: to } },
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
                .filter((t) => t.kind === "refund_route")
                .reduce((sum, t) => sum + BigInt(t.amount), 0n)
                .toString(),
              platformFee: route.platform_fee,
              networkFee: route.network_fee,
              txids: [...new Set(transfers.map((t) => t.txid))],
              payments: (invoice.payments ?? [])
                .filter((p) => p.payout === route.n)
                .map((p) => ({ txid: p.txid, amount: p.amount, onTime: p.on_time })),
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

async function deliverDueEvents(ports: WebhookPorts): Promise<void> {
  const now = ports.now();
  const due = await WebhookEvent.find({
    deliveredAt: null,
    failedAt: null,
    nextAttemptAt: { $lte: new Date(now) },
  })
    .sort({ nextAttemptAt: 1 })
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
