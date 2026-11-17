import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Db } from "mongodb";

import { computeBlindIndex } from "../../src/security/blind-index.js";
import { postJson, startTestApp } from "../helpers/http-app.js";

// Payer-pays mode through the merchant API and the payer's page: the payer
// is asked for the invoice amount plus the platform fee plus the estimated
// network cost, so the merchant gets the invoice amount.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const BTC_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const TON_ADDRESS = "UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_";
const PRICES: Record<string, string> = { btc: "50000", ton: "5" }; // USD per coin

type Estimate = bigint | "unsupported" | undefined;
let estimates: Record<string, Estimate>;
let estimateCalls: string[];

let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp({
    getPrice: async (coin) => PRICES[coin],
    estimateNetworkCost: async (coin) => {
      estimateCalls.push(coin);
      return coin in estimates ? estimates[coin] : "unsupported";
    },
  }));
});

beforeEach(() => {
  estimates = { btc: 2_440n, ton: 5_000_000n };
  estimateCalls = [];
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
});

async function merchant(fee = "0.05") {
  const userId = randomUUID();
  const apiKey = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    api_key_hash: computeBlindIndex("api-key", apiKey),
    merchant_fee: fee,
    payout_addresses: { btc: BTC_ADDRESS, ton: TON_ADDRESS },
  });
  return { userId, apiKey };
}

async function createInvoice(apiKey: string, body: Record<string, unknown>) {
  return await postJson(`${baseUrl}/invoices`, { amount: "25", ...body }, { merchant_key: apiKey });
}

async function invoiceInDb(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

async function merchantView(apiKey: string, invoiceId: string) {
  const response = await fetch(`${baseUrl}/invoices/${invoiceId}`, { headers: { merchant_key: apiKey } });
  return { status: response.status, body: await response.json() };
}

describe("creating a fixed-coin invoice", () => {
  it("asks the payer for the invoice amount when the merchant pays the fees (the default)", async () => {
    const m = await merchant();

    const response = await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc" });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.amount, "50000"); // $25 at $50,000/BTC
    assert.equal(response.body.data.askedAmount, "50000");
    assert.equal(response.body.data.feePaidByPayer, false);
    const invoice = await invoiceInDb(response.body.data.invoiceId);
    assert.equal(invoice?.fee_paid_by_payer, false);
    assert.equal(invoice?.asked_amount, "50000");
    assert.deepEqual(estimateCalls, [], "no estimate is needed when the merchant pays");
  });

  it("asks for the invoice plus the fee plus the estimated network cost when the payer pays", async () => {
    const m = await merchant("0.05");

    const response = await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc", fee_paid_by_payer: true });

    assert.equal(response.status, 201);
    // (50,000 + 2,440) / 0.95 = 55,200 exactly; fee 2,760; 55,200 − 2,760 − 2,440 = 50,000
    assert.equal(response.body.data.amount, "50000");
    assert.equal(response.body.data.askedAmount, "55200");
    assert.equal(response.body.data.feePaidByPayer, true);
    const invoice = await invoiceInDb(response.body.data.invoiceId);
    assert.equal(invoice?.fee_paid_by_payer, true);
    assert.equal(invoice?.amount, "50000");
    assert.equal(invoice?.asked_amount, "55200");
    assert.deepEqual(estimateCalls, ["btc"]);
  });

  it("asks for the invoice plus the network cost only at a 0% fee", async () => {
    const m = await merchant("0");

    const response = await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc", fee_paid_by_payer: true });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.askedAmount, "52440"); // 50,000 + 2,440
  });

  it("is refused with 409 for a coin with no network-cost estimate, and creates nothing", async () => {
    const m = await merchant();
    estimates = { ton: 5_000_000n };

    const response = await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc", fee_paid_by_payer: true });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "PAYER_PAYS_NOT_SUPPORTED");
    assert.equal(await db.collection("invoices").countDocuments({ user_id: m.userId }), 0);
  });

  it("answers 503 while the estimate is unavailable, and creates nothing", async () => {
    const m = await merchant();
    estimates = { btc: undefined };

    const response = await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc", fee_paid_by_payer: true });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "NETWORK_FEE_UNAVAILABLE");
    assert.equal(await db.collection("invoices").countDocuments({ user_id: m.userId }), 0);
  });

  it("refuses a flag that is not true or false", async () => {
    const m = await merchant();

    const response = await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc", fee_paid_by_payer: "yes" });

    assert.equal(response.status, 400);
  });

  it("shows the merchant both amounts", async () => {
    const m = await merchant();
    const { invoiceId } = (await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc", fee_paid_by_payer: true })).body.data;

    const view = await merchantView(m.apiKey, invoiceId);

    assert.equal(view.status, 200);
    assert.equal(view.body.data.amount, "50000");
    assert.equal(view.body.data.askedAmount, "55200");
    assert.equal(view.body.data.feePaidByPayer, true);
  });
});

describe("a merchant's-list invoice in payer-pays mode", () => {
  async function listInvoice(body: Record<string, unknown> = { fee_paid_by_payer: true }) {
    const m = await merchant("0.05");
    const response = await createInvoice(m.apiKey, { mode: "merchant_list", ...body });
    assert.equal(response.status, 201);
    return { ...m, invoiceId: response.body.data.invoiceId as string, created: response.body.data };
  }

  it("records the choice at creation and asks nothing until a coin is picked", async () => {
    const { invoiceId, created } = await listInvoice();

    assert.equal(created.feePaidByPayer, true);
    assert.equal((await invoiceInDb(invoiceId))?.fee_paid_by_payer, true);
    assert.deepEqual(estimateCalls, []);
  });

  it("asks for the fees on top when the payer picks a coin, and shows them the asked amount", async () => {
    const { invoiceId, apiKey } = await listInvoice();

    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "ton" });

    assert.equal(choice.status, 200);
    // $25 at $5/TON = 5 TON; (5 + 0.005) / 0.95 = 5.268421052… → 5,268,421,053 nanoton
    assert.equal(choice.body.data.payment.amount, "5268421053");
    const invoice = await invoiceInDb(invoiceId);
    assert.equal(invoice?.amount, "5000000000");
    assert.equal(invoice?.asked_amount, "5268421053");
    assert.deepEqual(estimateCalls, ["ton"]);

    const page = await fetch(`${baseUrl}/pay/${invoiceId}`).then((r) => r.json());
    assert.equal(page.data.payment.amount, "5268421053");
    const view = await merchantView(apiKey, invoiceId);
    assert.equal(view.body.data.amount, "5000000000");
    assert.equal(view.body.data.askedAmount, "5268421053");
  });

  it("asks only the invoice amount when the merchant pays", async () => {
    const { invoiceId } = await listInvoice({});

    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "ton" });

    assert.equal(choice.body.data.payment.amount, "5000000000");
    assert.equal((await invoiceInDb(invoiceId))?.asked_amount, "5000000000");
    assert.deepEqual(estimateCalls, []);
  });

  it("refuses a coin with no network-cost estimate with 409, and records no choice", async () => {
    const { invoiceId } = await listInvoice();
    estimates = { btc: 2_440n };

    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "ton" });

    assert.equal(choice.status, 409);
    assert.equal(choice.body.error.code, "PAYER_PAYS_NOT_SUPPORTED");
    assert.equal((await invoiceInDb(invoiceId))?.crypto, "");
  });

  it("answers 503 while the estimate is unavailable, and records no choice", async () => {
    const { invoiceId } = await listInvoice();
    estimates = { ton: undefined };

    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "ton" });

    assert.equal(choice.status, 503);
    assert.equal(choice.body.error.code, "NETWORK_FEE_UNAVAILABLE");
    assert.equal((await invoiceInDb(invoiceId))?.crypto, "");
  });
});
