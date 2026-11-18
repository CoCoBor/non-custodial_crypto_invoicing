import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import type { ChainAdapter, ChainPayment, PayoutRequest, PayoutResult, Transfer } from "../../src/chains/adapter.js";
import { connectToMongoDb, disconnectFromMongoDB } from "../../src/infrastructure/database/mongodb.js";
import { cancelUnpaidInvoice, createInvoice } from "../../src/invoice/invoice.repository.js";
import { runWatcherPass, type WatcherPorts } from "../../src/invoice/invoice.watcher.js";
import { sealSecret } from "../../src/security/secret-envelope.js";
import { runWebhookPass, statusEventId } from "../../src/webhooks/webhook-pass.js";
import { unusedSwap } from "../helpers/fake-swap.js";

// Every status change reaches the merchant's webhook outbox as its own event,
// in order, once: real watcher passes write the changes, real webhook passes
// read them. Fakes only at the chain and HTTP ports.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test

const NOW = Date.parse("2026-11-18T12:00:00Z");
const MINUTE = 60_000;
const AMOUNT = 100_000n;
const MERCHANT_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

let db: Db;
const invoiceIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  db = await connectToMongoDb();
});

after(async () => {
  await db.collection("invoices").deleteMany({ invoice_id: { $in: invoiceIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await db.collection("webhook_events").deleteMany({ invoiceId: { $in: invoiceIds } });
  await disconnectFromMongoDB();
});

function sealedKey() {
  return {
    keyVersion: 1,
    initialisationVector: randomBytes(12),
    authenticationTag: randomBytes(16),
    ciphertext: randomBytes(32),
  };
}

async function merchantWithWebhook(): Promise<string> {
  const userId = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    webhook_url: "https://shop.example/hook",
    webhook_secret: sealSecret("webhook-secret", "whsec_outbox_test"),
  });
  return userId;
}

/** A paid BTC invoice whose "confirmed" was already announced. */
async function confirmedInvoice(userId: string) {
  const invoiceId = randomUUID();
  invoiceIds.push(invoiceId);
  const address = `deposit-${invoiceId}`;
  await db.collection("invoices").insertOne({
    invoice_id: invoiceId,
    user_id: userId,
    status: "confirmed",
    notified_status: "confirmed",
    crypto: "btc",
    to_crypto: "btc",
    to_address: MERCHANT_ADDRESS,
    amount: AMOUNT.toString(),
    amount_fiat: "2500",
    paid_amount: AMOUNT.toString(),
    address,
    lifetime: 30,
    fee_rate: "0.05",
    payments: [{ txid: `pay-${invoiceId}`, amount: AMOUNT.toString(), first_seen_at: NOW - 10 * MINUTE, confirmations: 3, on_time: true }],
    timestamps: { created: NOW - 10 * MINUTE, waiting: NOW - 10 * MINUTE, confirmed: NOW - 5 * MINUTE },
    private: { private_key: sealedKey() },
  });
  return { invoiceId, address };
}

type FakePayout = (request: PayoutRequest) => Promise<PayoutResult>;

/** Saves a checkpoint (confirmed → processing), then proves it at once (→ completed). */
const paysAtOnce: FakePayout = async (request) => {
  const transfers: Transfer[] = [
    { kind: "merchant_payout", to: request.destination, amount: 94_000n, txid: `out-${request.depositAddress}` },
    { kind: "platform_fee", to: "platform", amount: 5_000n, txid: `fee-${request.depositAddress}` },
  ];
  await request.saveCheckpoint({ state: "signed", plan: { transfers, platformFee: 5_000n, networkCost: 1_000n } });
  return { status: "paid", transfers };
};

/** Saves a checkpoint (confirmed → processing), then fails (→ failed). */
const failsAfterSaving: FakePayout = async (request) => {
  await request.saveCheckpoint({ state: "signed", plan: { transfers: [], platformFee: 5_000n, networkCost: 1_000n } });
  return { status: "failed", message: "the fake chain refused it", transfers: [] };
};

function fakeChain(payments: Map<string, ChainPayment[]>, payout: FakePayout): ChainAdapter {
  return {
    asset: "btc",
    requiredConfirmations: 1,
    isValidAddress: (address) => address === MERCHANT_ADDRESS,
    canPayOutAs: (receive) => receive === "btc",
    newDeposit: async () => {
      throw new Error("not used by the watcher");
    },
    getPayments: async (address) => payments.get(address) ?? [],
    estimateNetworkCost: async () => 0n,
    payout,
  };
}

function watcher(now: () => number, payments: Map<string, ChainPayment[]>, payout: FakePayout) {
  const ports: WatcherPorts = { now, chains: { btc: fakeChain(payments, payout) }, swap: unusedSwap() };
  return async () => await runWatcherPass(ports);
}

const posted: string[] = [];
async function webhookPass(now: number) {
  await runWebhookPass({
    now: () => now,
    isAllowedDestination: async () => true,
    post: async (_url, init) => {
      posted.push(String(init?.body));
      return new Response(null, { status: 200 });
    },
  });
}

async function outbox(invoiceId: string) {
  const events = await db.collection("webhook_events").find({ invoiceId }).sort({ _id: 1 }).toArray();
  return events.map((e) => ({ eventId: e.eventId as string, body: JSON.parse(e.payload as string) }));
}

const postedFor = (invoiceId: string) =>
  posted.map((body) => JSON.parse(body)).filter((body) => body.invoiceId === invoiceId);

const statusEvents = async (invoiceId: string) =>
  (await outbox(invoiceId)).filter((e) => e.body.event === "invoice.status_changed");

describe("every status change is its own webhook event", () => {
  it("announces a payout too small to forward as one failed event that carries the outcome", async () => {
    const { invoiceId, address } = await confirmedInvoice(await merchantWithWebhook());
    const payments = new Map([[address, [{ txid: `pay-${invoiceId}`, amount: AMOUNT, confirmations: 3 }]]]);
    const watch = watcher(() => NOW, payments, async () => ({ status: "too_small", reason: "fees exceed it" }));

    await watch();
    await webhookPass(NOW);

    const events = await outbox(invoiceId);
    assert.deepEqual(
      events.map((e) => [e.body.event, e.body.status, e.body.outcome]),
      [["invoice.status_changed", "failed", "too_small_to_forward"]],
    );
  });

  it("announces two changes made between two webhook passes as two events, in order", async () => {
    const { invoiceId } = await confirmedInvoice(await merchantWithWebhook());
    const watch = watcher(() => NOW, new Map(), paysAtOnce);

    await watch(); // confirmed → processing → completed, inside one watcher pass
    await webhookPass(NOW);

    const events = await statusEvents(invoiceId);
    assert.deepEqual(events.map((e) => e.body.status), ["processing", "completed"]);
    assert.deepEqual(postedFor(invoiceId).map((b) => b.status), ["processing", "completed"], "posted in order");
    assert.equal(new Set(events.map((e) => e.eventId)).size, 2);
  });

  it("announces the whole life of an invoice made by the real repository, even when the webhook pass sees it only at the end", async () => {
    let now = Date.now();
    const userId = await merchantWithWebhook();
    const created = await createInvoice({
      userId,
      paymentUnits: AMOUNT,
      askedAmount: AMOUNT,
      feePaidByPayer: false,
      priceUnit: "usd",
      priceUnits: 2500n,
      lockedRate: {
        locked_at: now,
        coin_price_usd: "25000",
        coin_price_usd_at: now,
        fiat_per_usd: "1",
        fiat_per_usd_at: null,
        price_asset_price_usd: null,
        price_asset_price_usd_at: null,
      },
      deposit: { address: `deposit-${randomUUID()}`, key: { kind: "sealed_key", sealed: sealedKey() } },
      crypto: "btc",
      payoutAddress: MERCHANT_ADDRESS,
      toCrypto: "btc",
      lifetime: 30,
      underpaid: 0,
      feeRate: "0.05",
    });
    const invoiceId = created.invoiceId;
    invoiceIds.push(invoiceId);
    const payments = new Map<string, ChainPayment[]>();
    const watch = watcher(() => now, payments, paysAtOnce);

    payments.set(created.address, [{ txid: "tx-1", amount: AMOUNT, confirmations: 0 }]);
    await watch(); // waiting → confirming
    payments.set(created.address, [{ txid: "tx-1", amount: AMOUNT, confirmations: 1 }]);
    now += MINUTE;
    await watch(); // confirming → confirmed
    now += MINUTE;
    await watch(); // confirmed → processing → completed
    await webhookPass(now);

    assert.deepEqual(
      (await statusEvents(invoiceId)).map((e) => e.body.status),
      ["waiting", "confirming", "confirmed", "processing", "completed"],
    );
  });

  it("announces the same change twice when it happens twice: a payout fails, an operator retries it, it fails again", async () => {
    const { invoiceId } = await confirmedInvoice(await merchantWithWebhook());
    const watch = watcher(() => NOW, new Map(), failsAfterSaving);

    await watch(); // confirmed → processing → failed
    await webhookPass(NOW);
    // The operator's retry is a database edit, so no code path logs it.
    await db.collection("invoices").updateOne({ invoice_id: invoiceId }, { $set: { status: "confirmed" } });
    await watch(); // confirmed → processing → failed, again
    await webhookPass(NOW + MINUTE);

    const events = await statusEvents(invoiceId);
    assert.deepEqual(events.map((e) => e.body.status), ["processing", "failed", "confirmed", "processing", "failed"]);
    assert.equal(new Set(events.map((e) => e.eventId)).size, 5, "every event id is unique");
    assert.deepEqual(postedFor(invoiceId).map((b) => b.status), ["processing", "failed", "confirmed", "processing", "failed"]);
  });

  it("announces a database edit made after the last logged change", async () => {
    const { invoiceId } = await confirmedInvoice(await merchantWithWebhook());
    const watch = watcher(() => NOW, new Map(), failsAfterSaving);
    await watch();
    await db.collection("invoices").updateOne({ invoice_id: invoiceId }, { $set: { status: "confirmed" } });

    await webhookPass(NOW);

    assert.deepEqual((await statusEvents(invoiceId)).map((e) => e.body.status), ["processing", "failed", "confirmed"]);
  });

  it("announces cancels and merchant's-list expiries", async () => {
    const userId = await merchantWithWebhook();
    const { invoiceId: cancelled, address } = await confirmedInvoice(userId);
    await db.collection("invoices").updateOne(
      { invoice_id: cancelled },
      { $set: { status: "waiting", notified_status: "waiting", paid_amount: "0", payments: [] } },
    );
    const expired = randomUUID();
    invoiceIds.push(expired);
    await db.collection("invoices").insertOne({
      invoice_id: expired,
      user_id: userId,
      mode: "merchant_list",
      status: "waiting",
      notified_status: "waiting",
      crypto: "",
      amount: "0",
      amount_fiat: "2500",
      paid_amount: "0",
      lifetime: 30,
      timestamps: { created: NOW - 31 * MINUTE, waiting: NOW - 31 * MINUTE },
    });

    assert.equal(await cancelUnpaidInvoice(cancelled, address, NOW), true);
    await watcher(() => NOW, new Map(), paysAtOnce)();
    await webhookPass(NOW);

    assert.deepEqual((await statusEvents(cancelled)).map((e) => e.body.status), ["cancelled"]);
    assert.deepEqual((await statusEvents(expired)).map((e) => e.body.status), ["expired"]);
  });

  it("records each event once even if a pass stopped after recording but before marking them announced", async () => {
    const { invoiceId } = await confirmedInvoice(await merchantWithWebhook());
    await watcher(() => NOW, new Map(), paysAtOnce)();
    const before = await db.collection("invoices").findOne({ invoice_id: invoiceId });

    await webhookPass(NOW);
    // Undo the marking, as a crash right after recording would have left it.
    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      {
        $set: {
          notified_status: before?.notified_status,
          notified_status_log: before?.notified_status_log ?? 0,
          status_event_count: before?.status_event_count ?? 0,
        },
      },
    );
    await webhookPass(NOW + MINUTE);
    await webhookPass(NOW + 2 * MINUTE);

    const events = await statusEvents(invoiceId);
    assert.deepEqual(events.map((e) => e.body.status), ["processing", "completed"]);
    assert.equal(postedFor(invoiceId).length, 2, "each event posted once");
  });

  it("keeps the old id for a change found on an invoice written before the log existed", async () => {
    const { invoiceId } = await confirmedInvoice(await merchantWithWebhook());
    await db.collection("invoices").updateOne({ invoice_id: invoiceId }, { $set: { notified_status: "" } });

    await webhookPass(NOW);

    assert.deepEqual((await statusEvents(invoiceId)).map((e) => e.eventId), [statusEventId(invoiceId, "", "confirmed")]);
  });
});
