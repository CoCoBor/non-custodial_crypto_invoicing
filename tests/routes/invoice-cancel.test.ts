import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import type { ChainAdapter, ChainPayment } from "../../src/chains/adapter.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";
import { logIn, postJson, registerMerchant, startTestApp } from "../helpers/http-app.js";

// Cancelling an invoice, by the merchant (dashboard, session) or the payer
// (public page). "No payment seen" is asked of the chain at cancel time, so a
// payment the watcher has not recorded yet still blocks the cancel.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const WEEK = 7 * 24 * 60 * 60_000;

/** What the fake chain shows per deposit address. */
const chain = new Map<string, ChainPayment[] | "lookup fails">();
const lookedUp: string[] = [];

const fakeBtc: ChainAdapter = {
  asset: "btc",
  requiredConfirmations: 1,
  isValidAddress: () => true,
  canPayOutAs: (receive) => receive === "btc",
  newDeposit: async () => {
    throw new Error("not used here");
  },
  getPayments: async (address) => {
    lookedUp.push(address);
    const payments = chain.get(address);
    if (payments === "lookup fails") return undefined;
    return payments ?? [];
  },
  estimateNetworkCost: async () => 0n,
  payout: async () => ({ status: "pending", reason: "not used here" }),
};

let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp({ chains: { btc: fakeBtc } }));
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await db.collection("sessions").deleteMany({ userId: { $in: userIds } });
  await stop();
});

async function loggedInMerchant() {
  const merchant = await registerMerchant(baseUrl);
  userIds.push(merchant.userId);
  const { cookie } = await logIn(baseUrl, merchant);
  return { userId: merchant.userId, cookie };
}

/** A waiting BTC invoice of `userId`, nothing recorded as paid. */
async function waitingInvoice(userId: string, fields: Record<string, unknown> = {}) {
  const invoiceId = randomUUID();
  const address = `deposit-${invoiceId}`;
  const now = Date.now();
  await db.collection("invoices").insertOne({
    invoice_id: invoiceId,
    user_id: userId,
    status: "waiting",
    mode: "fixed",
    crypto: "btc",
    to_crypto: "btc",
    to_address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    amount: "100000",
    amount_fiat: "2500",
    paid_amount: "0",
    address,
    lifetime: 30,
    timestamps: { created: now, waiting: now },
    private: {
      private_key: {
        keyVersion: 1,
        initialisationVector: randomBytes(12),
        authenticationTag: randomBytes(16),
        ciphertext: randomBytes(32),
      },
    },
    ...fields,
  });
  return { invoiceId, address };
}

async function invoiceInDb(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

const merchantCancel = (invoiceId: string, cookie: string) =>
  postJson(`${baseUrl}/dashboard/invoices/${invoiceId}/cancel`, {}, { cookie });
const payerCancel = (invoiceId: string) => postJson(`${baseUrl}/pay/${invoiceId}/cancel`);

describe("the merchant cancelling from the dashboard", () => {
  it("cancels an invoice the chain shows no payment for, and starts the 7-day watch", async () => {
    const m = await loggedInMerchant();
    const { invoiceId, address } = await waitingInvoice(m.userId);
    chain.set(address, []);
    const before = Date.now();

    const response = await merchantCancel(invoiceId, m.cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, "cancelled");
    const invoice = await invoiceInDb(invoiceId);
    assert.equal(invoice?.status, "cancelled");
    assert.ok(invoice?.timestamps?.cancelled >= before);
    assert.equal(invoice?.watch_until, invoice?.timestamps?.cancelled + WEEK);
    assert.ok(lookedUp.includes(address), "cancelled without asking the chain");
  });

  it("refuses once the chain shows a payment, even one the watcher has not recorded", async () => {
    const m = await loggedInMerchant();
    const { invoiceId, address } = await waitingInvoice(m.userId);
    chain.set(address, [{ txid: "tx-just-sent", amount: 1_000n, confirmations: 0 }]);

    const response = await merchantCancel(invoiceId, m.cookie);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "CANNOT_CANCEL");
    assert.equal((await invoiceInDb(invoiceId))?.status, "waiting");
  });

  it("refuses once the watcher has recorded a payment", async () => {
    const m = await loggedInMerchant();
    const { invoiceId, address } = await waitingInvoice(m.userId, { status: "underpaid", paid_amount: "1000" });
    chain.set(address, []);

    const response = await merchantCancel(invoiceId, m.cookie);

    assert.equal(response.status, 409);
    assert.equal((await invoiceInDb(invoiceId))?.status, "underpaid");
  });

  it("refuses, rather than cancel blind, when the chain lookup fails", async () => {
    const m = await loggedInMerchant();
    const { invoiceId, address } = await waitingInvoice(m.userId);
    chain.set(address, "lookup fails");

    const response = await merchantCancel(invoiceId, m.cookie);

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "CHAIN_UNAVAILABLE");
    assert.equal((await invoiceInDb(invoiceId))?.status, "waiting");
  });

  it("answers 404 for another merchant's invoice and leaves it alone", async () => {
    const owner = await loggedInMerchant();
    const other = await loggedInMerchant();
    const { invoiceId, address } = await waitingInvoice(owner.userId);
    chain.set(address, []);

    const response = await merchantCancel(invoiceId, other.cookie);

    assert.equal(response.status, 404);
    assert.equal((await invoiceInDb(invoiceId))?.status, "waiting");
  });

  it("needs a logged-in session: no cookie, or the API key, gets 401", async () => {
    const userId = randomUUID();
    const apiKey = randomUUID();
    userIds.push(userId);
    await db.collection("users").insertOne({
      user_id: userId,
      api_key_hash: computeBlindIndex("api-key", apiKey),
      merchant_fee: "0.05",
    });
    const { invoiceId, address } = await waitingInvoice(userId);
    chain.set(address, []);

    const withKey = await postJson(`${baseUrl}/dashboard/invoices/${invoiceId}/cancel`, {}, { merchant_key: apiKey });
    const anonymous = await postJson(`${baseUrl}/dashboard/invoices/${invoiceId}/cancel`);

    assert.equal(withKey.status, 401);
    assert.equal(anonymous.status, 401);
    assert.equal((await invoiceInDb(invoiceId))?.status, "waiting");
  });

  it("cancels a merchant's-list invoice whose payer never picked a coin, with nothing to look up", async () => {
    const m = await loggedInMerchant();
    const { invoiceId } = await waitingInvoice(m.userId, {
      mode: "merchant_list",
      crypto: "",
      to_crypto: "",
      address: "",
      amount: "0",
      private: {},
    });

    const response = await merchantCancel(invoiceId, m.cookie);

    assert.equal(response.status, 200);
    assert.equal((await invoiceInDb(invoiceId))?.status, "cancelled");
  });
});

describe("the payer cancelling, checked against the chain", () => {
  /** The payer needs no account: any merchant's invoice. */
  async function payersInvoice() {
    const userId = randomUUID();
    userIds.push(userId);
    return await waitingInvoice(userId);
  }

  it("refuses once the chain shows a payment the watcher has not recorded yet", async () => {
    const { invoiceId, address } = await payersInvoice();
    chain.set(address, [{ txid: "tx-in-mempool", amount: 50_000n, confirmations: 0 }]);

    const response = await payerCancel(invoiceId);

    assert.equal(response.status, 409);
    assert.equal((await invoiceInDb(invoiceId))?.status, "waiting");
  });

  it("refuses, rather than cancel blind, when the chain lookup fails", async () => {
    const { invoiceId, address } = await payersInvoice();
    chain.set(address, "lookup fails");

    const response = await payerCancel(invoiceId);

    assert.equal(response.status, 503);
    assert.equal((await invoiceInDb(invoiceId))?.status, "waiting");
  });

  it("cancels when the chain shows nothing, and starts the 7-day watch", async () => {
    const { invoiceId, address } = await payersInvoice();
    chain.set(address, []);

    const response = await payerCancel(invoiceId);

    assert.equal(response.status, 200);
    const invoice = await invoiceInDb(invoiceId);
    assert.equal(invoice?.status, "cancelled");
    assert.equal(invoice?.watch_until, invoice?.timestamps?.cancelled + WEEK);
  });
});
