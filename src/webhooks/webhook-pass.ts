import { createHmac, randomUUID } from "node:crypto";

import { Invoice } from "../database/invoices.model.js";
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

/** Records new invoice statuses as events, then sends the events that are due. */
export async function runWebhookPass(ports: WebhookPorts): Promise<void> {
  await recordStatusChanges(ports.now());
  await deliverDueEvents(ports);
}

// An invoice's status can be changed by many parts of the code; comparing it
// with the last status announced catches every change in one place. Two
// changes between passes are announced once, with the latest status.
async function recordStatusChanges(now: number): Promise<void> {
  const changed = await Invoice.find({
    $expr: { $ne: ["$status", { $ifNull: ["$notified_status", ""] }] },
  })
    .select(
      "invoice_id user_id status notified_status outcome crypto to_crypto amount amount_fiat paid_amount tx.in tx.out tx.platform_out -_id",
    )
    .lean()
    .exec();

  for (const invoice of changed) {
    const claimed = await Invoice.updateOne(
      {
        invoice_id: invoice.invoice_id,
        status: invoice.status,
        notified_status: invoice.notified_status ?? null,
      },
      { $set: { notified_status: invoice.status } },
    ).exec();
    if (claimed.modifiedCount !== 1) continue;

    const merchant = await User.findOne({ user_id: invoice.user_id })
      .select("webhook_url")
      .lean()
      .exec();
    if (!merchant?.webhook_url) continue;

    const eventId = randomUUID();
    await WebhookEvent.create({
      eventId,
      userId: invoice.user_id,
      invoiceId: invoice.invoice_id,
      status: invoice.status,
      payload: JSON.stringify({
        event: "invoice.status_changed",
        eventId,
        invoiceId: invoice.invoice_id,
        status: invoice.status,
        outcome: invoice.outcome ?? "",
        crypto: invoice.crypto,
        toCrypto: invoice.to_crypto,
        amount: invoice.amount,
        amountFiat: invoice.amount_fiat,
        paidAmount: invoice.paid_amount,
        txids: {
          in: invoice.tx?.in ?? "",
          out: invoice.tx?.out ?? "",
          platformOut: invoice.tx?.platform_out ?? "",
        },
        occurredAt: new Date(now).toISOString(),
      }),
      nextAttemptAt: new Date(now),
    });
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
