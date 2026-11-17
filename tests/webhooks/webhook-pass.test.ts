import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Db } from "mongodb";

import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { sealSecret } from "../../src/security/secret-envelope.js";
import { runWebhookPass, statusEventId, type WebhookPorts } from "../../src/webhooks/webhook-pass.js";

// Status changes become signed POSTs to the merchant's webhook URL.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const NOW = Date.parse("2026-11-17T12:00:00Z");
const MINUTE = 60_000;
const SECRET = "whsec_test_secret_value";

type Received = { headers: Record<string, string | string[] | undefined>; body: string };

let db: Db;
let shop: Server;
let shopUrl: string;
let received: Received[];
let shopAnswers: number; // HTTP status the shop's server answers with
const userIds: string[] = [];
const invoiceIds: string[] = [];

before(async () => {
  db = await connectToMongoDb();
  shop = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (shopAnswers === 302) res.setHeader("location", "https://elsewhere.example/");
      res.statusCode = shopAnswers;
      res.end();
    });
  });
  shop.listen(0, "127.0.0.1");
  await once(shop, "listening");
  shopUrl = `http://127.0.0.1:${(shop.address() as AddressInfo).port}/hook`;
});

beforeEach(() => {
  received = [];
  shopAnswers = 200;
});

after(async () => {
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await db.collection("invoices").deleteMany({ invoice_id: { $in: invoiceIds } });
  await db.collection("webhook_events").deleteMany({ invoiceId: { $in: invoiceIds } });
  await new Promise<void>((resolve) => shop.close(() => resolve()));
  await disconnectFromMongoDB();
});

/** The local test shop is on 127.0.0.1, which the real guard refuses. */
function ports(now = NOW): WebhookPorts {
  return { now: () => now, isAllowedDestination: async () => true, post: fetch };
}

async function merchant(webhookUrl: string | undefined = shopUrl) {
  const userId = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    webhook_url: webhookUrl ?? "",
    webhook_secret: webhookUrl ? sealSecret("webhook-secret", SECRET) : null,
  });
  return userId;
}

async function invoiceOf(userId: string, status: string) {
  const invoiceId = randomUUID();
  invoiceIds.push(invoiceId);
  await db.collection("invoices").insertOne({
    invoice_id: invoiceId,
    user_id: userId,
    status,
    notified_status: "",
    crypto: "btc",
    to_crypto: "btc",
    amount: "100000",
    amount_fiat: "2500",
    paid_amount: "100000",
    address: "deposit",
  });
  return invoiceId;
}

function signatureIsValid(request: Received): boolean {
  const timestamp = String(request.headers["x-webhook-timestamp"]);
  const expected = createHmac("sha256", SECRET).update(`${timestamp}.${request.body}`).digest("hex");
  return request.headers["x-webhook-signature"] === `sha256=${expected}`;
}

const forInvoice = (invoiceId: string) => received.filter((r) => JSON.parse(r.body).invoiceId === invoiceId);

describe("turning status changes into webhooks", () => {
  it("sends one signed POST with the invoice's new status", async () => {
    const invoiceId = await invoiceOf(await merchant(), "confirmed");

    await runWebhookPass(ports());

    const requests = forInvoice(invoiceId);
    assert.equal(requests.length, 1);
    assert.ok(signatureIsValid(requests[0]!), "bad signature");
    assert.equal(requests[0]!.headers["x-webhook-timestamp"], String(Math.floor(NOW / 1000)));
    const body = JSON.parse(requests[0]!.body);
    assert.equal(body.event, "invoice.status_changed");
    assert.equal(body.status, "confirmed");
    assert.equal(body.paidAmount, "100000");
  });

  it("does not send the same status twice", async () => {
    const invoiceId = await invoiceOf(await merchant(), "confirmed");

    await runWebhookPass(ports());
    await runWebhookPass(ports(NOW + MINUTE));

    assert.equal(forInvoice(invoiceId).length, 1);
  });

  it("sends again when the status changes again", async () => {
    const invoiceId = await invoiceOf(await merchant(), "confirmed");
    await runWebhookPass(ports());
    await db.collection("invoices").updateOne({ invoice_id: invoiceId }, { $set: { status: "completed" } });

    await runWebhookPass(ports(NOW + MINUTE));

    assert.deepEqual(forInvoice(invoiceId).map((r) => JSON.parse(r.body).status), ["confirmed", "completed"]);
  });

  it("records a change once even if the last pass stopped before marking it announced", async () => {
    const userId = await merchant();
    const invoiceId = await invoiceOf(userId, "confirmed");
    // A crash after recording the event but before moving notified_status.
    await db.collection("webhook_events").insertOne({
      eventId: statusEventId(invoiceId, "", "confirmed"),
      userId,
      invoiceId,
      status: "confirmed",
      payload: JSON.stringify({ invoiceId, status: "confirmed" }),
      attempts: 0,
      nextAttemptAt: new Date(NOW),
      deliveredAt: null,
      failedAt: null,
    });

    await runWebhookPass(ports());

    assert.equal(await db.collection("webhook_events").countDocuments({ invoiceId }), 1);
    assert.equal((await db.collection("invoices").findOne({ invoice_id: invoiceId }))?.notified_status, "confirmed");
    assert.equal(forInvoice(invoiceId).length, 1);
  });

  it("includes the money: platform fee, network fee and the merchant's amount", async () => {
    const userId = await merchant();
    const invoiceId = await invoiceOf(userId, "completed");
    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      { $set: { platform_fee: "5000", network_fee: "700", received_amount: "94300" } },
    );

    await runWebhookPass(ports());

    const body = JSON.parse(forInvoice(invoiceId)[0]!.body);
    assert.equal(body.platformFee, "5000");
    assert.equal(body.networkFee, "700");
    assert.equal(body.merchantAmount, "94300");
  });

  it("includes what the payer was asked for, which is more than the amount in payer-pays mode", async () => {
    const userId = await merchant();
    const payerPays = await invoiceOf(userId, "confirmed");
    const merchantPays = await invoiceOf(userId, "confirmed");
    await db.collection("invoices").updateOne(
      { invoice_id: payerPays },
      { $set: { fee_paid_by_payer: true, asked_amount: "107832" } },
    );

    await runWebhookPass(ports());

    const payerPaysBody = JSON.parse(forInvoice(payerPays)[0]!.body);
    assert.equal(payerPaysBody.amount, "100000");
    assert.equal(payerPaysBody.askedAmount, "107832");
    assert.equal(payerPaysBody.feePaidByPayer, true);
    // Made before the asked amount was stored: it asked for the amount.
    const merchantPaysBody = JSON.parse(forInvoice(merchantPays)[0]!.body);
    assert.equal(merchantPaysBody.askedAmount, "100000");
    assert.equal(merchantPaysBody.feePaidByPayer, false);
  });

  it("sends nothing for a merchant without a webhook URL", async () => {
    const invoiceId = await invoiceOf(await merchant(""), "confirmed");

    await runWebhookPass(ports());

    assert.equal(forInvoice(invoiceId).length, 0);
    const invoice = await db.collection("invoices").findOne({ invoice_id: invoiceId });
    assert.equal(invoice?.notified_status, "confirmed", "a later URL would replay old news");
  });
});

describe("retrying a failed delivery", () => {
  it("waits a minute before trying again", async () => {
    shopAnswers = 500;
    const invoiceId = await invoiceOf(await merchant(), "confirmed");

    await runWebhookPass(ports());
    await runWebhookPass(ports(NOW + 30_000));
    assert.equal(forInvoice(invoiceId).length, 1, "retried too early");

    shopAnswers = 200;
    await runWebhookPass(ports(NOW + MINUTE + 1));
    assert.equal(forInvoice(invoiceId).length, 2);
    const event = await db.collection("webhook_events").findOne({ invoiceId });
    assert.ok(event?.deliveredAt);
  });

  it("gives up after five failed attempts", async () => {
    shopAnswers = 500;
    const invoiceId = await invoiceOf(await merchant(), "confirmed");

    for (const at of [0, 1, 6, 36, 156, 876].map((minutes) => NOW + minutes * MINUTE + 1)) {
      await runWebhookPass(ports(at));
    }

    assert.equal(forInvoice(invoiceId).length, 5);
    const event = await db.collection("webhook_events").findOne({ invoiceId });
    assert.ok(event?.failedAt);
    assert.equal(event?.attempts, 5);
  });

  it("treats a redirect as a failure and never follows it", async () => {
    shopAnswers = 302;
    const invoiceId = await invoiceOf(await merchant(), "confirmed");

    await runWebhookPass(ports());

    const event = await db.collection("webhook_events").findOne({ invoiceId });
    assert.equal(event?.attempts, 1);
    assert.ok(!event?.deliveredAt);
  });

  it("does not deliver to a destination the guard refuses", async () => {
    const invoiceId = await invoiceOf(await merchant(), "confirmed");

    await runWebhookPass({ ...ports(), isAllowedDestination: async () => false });

    assert.equal(forInvoice(invoiceId).length, 0);
    const event = await db.collection("webhook_events").findOne({ invoiceId });
    assert.equal(event?.attempts, 1);
    assert.match(event?.lastError ?? "", /not allowed/);
  });
});
