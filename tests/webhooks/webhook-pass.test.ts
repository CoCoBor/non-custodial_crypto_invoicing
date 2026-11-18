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
import {
  outcomeEventId,
  refundRouteEventId,
  refundRouteSwapEventId,
  runWebhookPass,
  statusEventId,
  swapEventId,
  type WebhookPorts,
} from "../../src/webhooks/webhook-pass.js";

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

  it("includes the price and the rate locked when the coin was chosen", async () => {
    const userId = await merchant();
    const inEur = await invoiceOf(userId, "confirmed");
    const beforeRates = await invoiceOf(userId, "confirmed");
    const lockedRate = {
      locked_at: NOW - MINUTE,
      coin_price_usd: "50000",
      coin_price_usd_at: NOW - MINUTE,
      fiat_per_usd: "0.8",
      fiat_per_usd_at: NOW - 60 * MINUTE,
      price_asset_price_usd: null,
      price_asset_price_usd_at: null,
    };
    await db.collection("invoices").updateOne(
      { invoice_id: inEur },
      { $set: { currency: "eur", amount_fiat: "4000", locked_rate: lockedRate } },
    );

    await runWebhookPass(ports());

    const body = JSON.parse(forInvoice(inEur)[0]!.body);
    assert.deepEqual(body.price, { unit: "eur", amount: "40" });
    assert.deepEqual(body.lockedRate, {
      lockedAt: NOW - MINUTE,
      coinPriceUsd: "50000",
      coinPriceUsdAt: NOW - MINUTE,
      fiatPerUsd: "0.8",
      fiatPerUsdAt: NOW - 60 * MINUTE,
      priceAssetPriceUsd: null,
      priceAssetPriceUsdAt: null,
    });
    // Made before the price unit and the rate were stored: USD, no rate.
    const olderBody = JSON.parse(forInvoice(beforeRates)[0]!.body);
    assert.deepEqual(olderBody.price, { unit: "usd", amount: "25" });
    assert.equal(olderBody.lockedRate, null);
  });

  it("lists every payment and every transfer, so an invoice paid in parts can be reconciled", async () => {
    const userId = await merchant();
    const paidInParts = await invoiceOf(userId, "completed");
    const unpaid = await invoiceOf(userId, "waiting");
    await db.collection("invoices").updateOne(
      { invoice_id: paidInParts },
      {
        $set: {
          crypto: "usdteth",
          to_crypto: "usdteth",
          payments: [
            { txid: "pay-1", amount: "60000", first_seen_at: NOW - 10 * MINUTE, confirmations: 3, on_time: true, payout: 0 },
            { txid: "pay-2", amount: "40000", first_seen_at: NOW - 9 * MINUTE, confirmations: 2, on_time: true, payout: 0 },
            { txid: "pay-late", amount: "7000", first_seen_at: NOW - MINUTE, confirmations: 1, on_time: false },
          ],
          transfers: [
            { kind: "gas_top_up", to: "deposit", amount: "4200000000000000", txid: "gas-tx", status: "confirmed" },
            { kind: "merchant_payout", to: "merchant", amount: "94300", txid: "out-tx", status: "confirmed" },
            { kind: "platform_fee", to: "platform", amount: "5000", txid: "fee-tx", status: "confirmed" },
            { kind: "gas_sweep", to: "gas-wallet", amount: "1300000000000000", txid: "sweep-tx", status: "confirmed" },
            { kind: "refund_route", to: "refund", amount: "6650", txid: "route-tx", status: "pending", payout: 1 },
          ],
          "tx.in": "pay-1",
        },
      },
    );

    await runWebhookPass(ports());

    const body = JSON.parse(forInvoice(paidInParts)[0]!.body);
    assert.deepEqual(body.payments, [
      { txid: "pay-1", amount: "60000", firstSeenAt: new Date(NOW - 10 * MINUTE).toISOString(), onTime: true },
      { txid: "pay-2", amount: "40000", firstSeenAt: new Date(NOW - 9 * MINUTE).toISOString(), onTime: true },
      { txid: "pay-late", amount: "7000", firstSeenAt: new Date(NOW - MINUTE).toISOString(), onTime: false },
    ]);
    // A token deposit's gas top-up, and the sweep of its unused gas, are in the chain's own coin.
    assert.deepEqual(body.transfers, [
      { kind: "gas_top_up", txid: "gas-tx", amount: "4200000000000000", asset: "eth", status: "confirmed" },
      { kind: "merchant_payout", txid: "out-tx", amount: "94300", asset: "usdteth", status: "confirmed" },
      { kind: "platform_fee", txid: "fee-tx", amount: "5000", asset: "usdteth", status: "confirmed" },
      { kind: "gas_sweep", txid: "sweep-tx", amount: "1300000000000000", asset: "eth", status: "confirmed" },
      { kind: "refund_route", txid: "route-tx", amount: "6650", asset: "usdteth", status: "pending" },
    ]);
    assert.deepEqual(body.txids, { in: "pay-1", out: "", platformOut: "" }, "the old fields stay");

    const unpaidBody = JSON.parse(forInvoice(unpaid)[0]!.body);
    assert.deepEqual(unpaidBody.payments, []);
    assert.deepEqual(unpaidBody.transfers, []);
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

describe("announcing what happens to money after an invoice closed", () => {
  /** A cancelled invoice whose cancel was already announced. */
  async function cancelledInvoice(userId: string, fields: Record<string, unknown> = {}) {
    const invoiceId = await invoiceOf(userId, "cancelled");
    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      { $set: { notified_status: "cancelled", paid_amount: "0", ...fields } },
    );
    return invoiceId;
  }

  const ROUTED = {
    payments: [
      { txid: "tx-late", amount: "50000", first_seen_at: NOW, confirmations: 1, on_time: false, payout: 1 },
    ],
    transfers: [
      { kind: "refund_route", to: "refund-address", amount: "46500", txid: "route-tx", status: "confirmed", payout: 1 },
      { kind: "platform_fee", to: "platform", amount: "2500", txid: "route-tx", status: "confirmed", payout: 1 },
    ],
    refund_routes: [
      {
        n: 1,
        destination: "refund-address",
        source: "refund_address",
        state: "paid",
        swept: "50000",
        platform_fee: "2500",
        network_fee: "1000",
        started_at: NOW - MINUTE,
        settled_at: NOW,
        notified: false,
      },
    ],
  };

  it("sends an outcome change that came without a status change, once", async () => {
    const invoiceId = await cancelledInvoice(await merchant(), {
      outcome: "too_small_to_forward",
      outcome_version: 1,
    });

    await runWebhookPass(ports());
    await runWebhookPass(ports(NOW + MINUTE));

    const requests = forInvoice(invoiceId);
    assert.equal(requests.length, 1);
    assert.ok(signatureIsValid(requests[0]!), "bad signature");
    const body = JSON.parse(requests[0]!.body);
    assert.equal(body.event, "invoice.outcome_changed");
    assert.equal(body.eventId, outcomeEventId(invoiceId, 1));
    assert.equal(body.status, "cancelled");
    assert.equal(body.outcome, "too_small_to_forward");
  });

  it("sends each later outcome change under a new id, even back to an earlier outcome", async () => {
    const invoiceId = await cancelledInvoice(await merchant(), { outcome: "too_small_to_forward", outcome_version: 1 });
    await runWebhookPass(ports());
    await db.collection("invoices").updateOne({ invoice_id: invoiceId }, { $set: { outcome: "", outcome_version: 2 } });
    await runWebhookPass(ports(NOW + MINUTE));
    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      { $set: { outcome: "too_small_to_forward", outcome_version: 3 } },
    );

    await runWebhookPass(ports(NOW + 2 * MINUTE));

    const bodies = forInvoice(invoiceId).map((r) => JSON.parse(r.body));
    assert.deepEqual(bodies.map((b) => [b.eventId, b.outcome]), [
      [outcomeEventId(invoiceId, 1), "too_small_to_forward"],
      [outcomeEventId(invoiceId, 2), ""],
      [outcomeEventId(invoiceId, 3), "too_small_to_forward"],
    ]);
  });

  it("sends a paid refund route once, with where the money went and which payments it carried", async () => {
    const invoiceId = await cancelledInvoice(await merchant(), ROUTED);

    await runWebhookPass(ports());
    await runWebhookPass(ports(NOW + MINUTE));

    const requests = forInvoice(invoiceId);
    assert.equal(requests.length, 1);
    assert.ok(signatureIsValid(requests[0]!), "bad signature");
    const body = JSON.parse(requests[0]!.body);
    assert.equal(body.event, "invoice.refund_routed");
    assert.equal(body.eventId, refundRouteEventId(invoiceId, 1));
    assert.equal(body.status, "cancelled");
    assert.deepEqual(body.refundRoute, {
      number: 1,
      destination: "refund-address",
      destinationSource: "refund_address",
      amount: "46500",
      platformFee: "2500",
      networkFee: "1000",
      txids: ["route-tx"],
      payments: [{ txid: "tx-late", amount: "50000", onTime: false }],
      swap: null,
    });
    const stored = await db.collection("invoices").findOne({ invoice_id: invoiceId });
    assert.equal(stored?.refund_routes?.[0]?.notified, true);
  });

  it("says nothing about a refund route until it is paid", async () => {
    const invoiceId = await cancelledInvoice(await merchant(), {
      ...ROUTED,
      refund_routes: [{ ...ROUTED.refund_routes[0], state: "processing" }],
    });

    await runWebhookPass(ports());

    assert.equal(forInvoice(invoiceId).length, 0);
  });

  it("records nothing for a merchant without a webhook URL, and does not replay it later", async () => {
    const userId = await merchant("");
    const invoiceId = await cancelledInvoice(userId, { ...ROUTED, outcome: "held_for_manual_handling", outcome_version: 1 });

    await runWebhookPass(ports());

    assert.equal(await db.collection("webhook_events").countDocuments({ invoiceId }), 0);
    const stored = await db.collection("invoices").findOne({ invoice_id: invoiceId });
    assert.equal(stored?.notified_outcome_version, 1);
    assert.equal(stored?.refund_routes?.[0]?.notified, true);
  });
});

describe("announcing swap status changes", () => {
  const SWAP = {
    provider: "near_intents",
    deposit_address: "swap-deposit-1",
    recipient: "0xmerchant",
    receive_crypto: "usdceth",
    status: "PENDING_DEPOSIT",
    deadline: "2026-11-18T12:00:00.000Z",
    amount_in: "94000",
    min_amount_out: "560000",
    amount_delivered: "0",
    amount_refunded: "0",
    refund_reason: "",
    destination_txids: [],
    version: 1,
    notified_version: 0,
  };

  /** A swap-mode invoice paid into a swap, its status already announced. */
  async function swapInvoice(userId: string, swap: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
    const invoiceId = await invoiceOf(userId, "processing");
    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      { $set: { notified_status: "processing", mode: "swap", to_crypto: "usdceth", swap: { ...SWAP, ...swap }, ...fields } },
    );
    return invoiceId;
  }

  const bodies = (invoiceId: string) => forInvoice(invoiceId).map((r) => JSON.parse(r.body));

  it("sends the swap's start once, with the provider, the deposit address and the amount sent in", async () => {
    const invoiceId = await swapInvoice(await merchant());

    await runWebhookPass(ports());
    await runWebhookPass(ports(NOW + MINUTE));

    const requests = forInvoice(invoiceId);
    assert.equal(requests.length, 1);
    assert.ok(signatureIsValid(requests[0]!), "bad signature");
    const body = JSON.parse(requests[0]!.body);
    assert.equal(body.event, "invoice.swap_changed");
    assert.equal(body.eventId, swapEventId(invoiceId, 1));
    assert.equal(body.status, "processing");
    assert.equal(body.swap.provider, "near_intents");
    assert.equal(body.swap.depositAddress, "swap-deposit-1");
    assert.equal(body.swap.status, "PENDING_DEPOSIT");
    assert.equal(body.swap.amountIn, "94000");
    assert.equal((await db.collection("invoices").findOne({ invoice_id: invoiceId }))?.swap?.notified_version, 1);
  });

  it("sends each later swap status under a new id: the delivered amount, then nothing more", async () => {
    const invoiceId = await swapInvoice(await merchant());
    await runWebhookPass(ports());
    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      {
        $set: {
          status: "completed",
          received_amount: "590000",
          "swap.status": "SUCCESS",
          "swap.amount_delivered": "590000",
          "swap.destination_txids": ["0xfeed"],
          "swap.version": 2,
        },
      },
    );

    await runWebhookPass(ports(NOW + MINUTE));
    await runWebhookPass(ports(NOW + 2 * MINUTE));

    const sent = bodies(invoiceId);
    assert.deepEqual(sent.map((b) => b.eventId), [
      swapEventId(invoiceId, 1),
      statusEventId(invoiceId, "processing", "completed"),
      swapEventId(invoiceId, 2),
    ]);
    const completed = sent[1]!;
    assert.equal(completed.swap.amountDelivered, "590000", "the status event carries the swap too");
    const delivered = sent[2]!;
    assert.equal(delivered.swap.status, "SUCCESS");
    assert.equal(delivered.swap.amountDelivered, "590000");
    assert.deepEqual(delivered.swap.deliveryTxids, ["0xfeed"]);
  });

  it("sends a refunded swap with the amount refunded and the provider's reason", async () => {
    const invoiceId = await swapInvoice(await merchant(), {
      status: "REFUNDED",
      amount_refunded: "92000",
      refund_reason: "slippage",
      version: 3,
      notified_version: 2,
    });

    await runWebhookPass(ports());

    const [body] = bodies(invoiceId).filter((b) => b.event === "invoice.swap_changed");
    assert.equal(body?.eventId, swapEventId(invoiceId, 3));
    assert.equal(body?.swap.status, "REFUNDED");
    assert.equal(body?.swap.amountRefunded, "92000");
    assert.equal(body?.swap.refundReason, "slippage");
  });

  it("records a swap change once even if the last pass stopped before marking it announced", async () => {
    const userId = await merchant();
    const invoiceId = await swapInvoice(userId);
    await db.collection("webhook_events").insertOne({
      eventId: swapEventId(invoiceId, 1),
      userId,
      invoiceId,
      status: "processing",
      payload: JSON.stringify({ invoiceId, event: "invoice.swap_changed" }),
      attempts: 0,
      nextAttemptAt: new Date(NOW),
      deliveredAt: null,
      failedAt: null,
    });

    await runWebhookPass(ports());

    assert.equal(await db.collection("webhook_events").countDocuments({ invoiceId }), 1);
    assert.equal(forInvoice(invoiceId).length, 1);
  });

  it("records nothing for a merchant without a webhook URL, and does not replay it later", async () => {
    const userId = await merchant("");
    const invoiceId = await swapInvoice(userId);

    await runWebhookPass(ports());

    assert.equal(await db.collection("webhook_events").countDocuments({ invoiceId }), 0);
    assert.equal((await db.collection("invoices").findOne({ invoice_id: invoiceId }))?.swap?.notified_version, 1);
  });

  describe("a fallback swap of refunded money (refund routing's swap to the receive coin)", () => {
    const ROUTE = {
      n: 1,
      destination: "swap-deposit-2",
      source: "swap_to_receive_coin",
      state: "swapping",
      swept: "92000",
      platform_fee: "4600",
      network_fee: "1000",
      started_at: NOW - MINUTE,
      settled_at: null,
      notified: false,
      swap: { ...SWAP, deposit_address: "swap-deposit-2", amount_in: "86400" },
    };
    const ROUTE_TRANSFERS = [
      { kind: "swap_deposit", to: "swap-deposit-2", amount: "86400", txid: "route-tx", status: "confirmed", payout: 1 },
      { kind: "platform_fee", to: "platform", amount: "4600", txid: "route-tx", status: "confirmed", payout: 1 },
    ];

    /** A failed swap invoice whose own swap and status were already announced. */
    async function withRoute(userId: string, route: Record<string, unknown>) {
      return await swapInvoice(
        userId,
        { status: "REFUNDED", amount_refunded: "92000", version: 2, notified_version: 2 },
        { status: "failed", notified_status: "failed", refund_routes: [route], transfers: ROUTE_TRANSFERS },
      );
    }

    it("sends the fallback swap's start once, with the route number and the swap", async () => {
      const invoiceId = await withRoute(await merchant(), ROUTE);

      await runWebhookPass(ports());
      await runWebhookPass(ports(NOW + MINUTE));

      const sent = bodies(invoiceId);
      assert.equal(sent.length, 1);
      const body = sent[0]!;
      assert.equal(body.event, "invoice.refund_route_swap_changed");
      assert.equal(body.eventId, refundRouteSwapEventId(invoiceId, 1, 1));
      assert.equal(body.status, "failed");
      assert.equal(body.refundRoute.number, 1);
      assert.equal(body.refundRoute.state, "swapping");
      assert.equal(body.refundRoute.destinationSource, "swap_to_receive_coin");
      assert.equal(body.refundRoute.swap.depositAddress, "swap-deposit-2");
      assert.equal(body.refundRoute.swap.amountIn, "86400");
      const stored = await db.collection("invoices").findOne({ invoice_id: invoiceId });
      assert.equal(stored?.refund_routes?.[0]?.swap?.notified_version, 1);
    });

    it("sends a refunded fallback swap with the amount refunded", async () => {
      const invoiceId = await withRoute(await merchant(), {
        ...ROUTE,
        state: "refunded",
        swap: { ...ROUTE.swap, status: "REFUNDED", amount_refunded: "85000", version: 2, notified_version: 1 },
      });

      await runWebhookPass(ports());

      const [body] = bodies(invoiceId);
      assert.equal(body?.eventId, refundRouteSwapEventId(invoiceId, 1, 2));
      assert.equal(body?.refundRoute.state, "refunded");
      assert.equal(body?.refundRoute.swap.status, "REFUNDED");
      assert.equal(body?.refundRoute.swap.amountRefunded, "85000");
    });

    it("sends a delivered fallback swap as a swap change and as a paid route, which counts the money sent into the swap", async () => {
      const invoiceId = await withRoute(await merchant(), {
        ...ROUTE,
        state: "paid",
        settled_at: NOW,
        swap: { ...ROUTE.swap, status: "SUCCESS", amount_delivered: "590000", destination_txids: ["0x0bad"], version: 2, notified_version: 1 },
      });

      await runWebhookPass(ports());

      const sent = bodies(invoiceId);
      assert.deepEqual(sent.map((b) => b.eventId).sort(), [
        refundRouteEventId(invoiceId, 1),
        refundRouteSwapEventId(invoiceId, 1, 2),
      ].sort());
      const routed = sent.find((b) => b.event === "invoice.refund_routed")!;
      assert.equal(routed.refundRoute.amount, "86400");
      assert.equal(routed.refundRoute.swap.amountDelivered, "590000");
      const changed = sent.find((b) => b.event === "invoice.refund_route_swap_changed")!;
      assert.equal(changed.refundRoute.swap.status, "SUCCESS");
      assert.equal(changed.refundRoute.swap.amountDelivered, "590000");
    });

    it("never gives two routes' swap changes the same id", async () => {
      const invoiceId = await withRoute(await merchant(), ROUTE);
      const second = { ...ROUTE, n: 2, destination: "swap-deposit-3", swap: { ...ROUTE.swap, deposit_address: "swap-deposit-3" } };
      await db.collection("invoices").updateOne({ invoice_id: invoiceId }, { $set: { refund_routes: [ROUTE, second] } });

      await runWebhookPass(ports());

      assert.deepEqual(bodies(invoiceId).map((b) => b.eventId).sort(), [
        refundRouteSwapEventId(invoiceId, 1, 1),
        refundRouteSwapEventId(invoiceId, 2, 1),
      ].sort());
    });
  });
});
