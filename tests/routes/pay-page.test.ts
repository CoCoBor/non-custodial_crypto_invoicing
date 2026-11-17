import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import type { ChainAdapter } from "../../src/chains/adapter.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";
import { postJson, startTestApp } from "../helpers/http-app.js";

// The payer's side: open the invoice, pick a coin once, or cancel before
// paying. Plus the merchant API creating both kinds of invoice.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const BTC_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const TON_ADDRESS = "UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_";
const PRICES: Record<string, string> = { btc: "50000", ton: "5" }; // USD per coin

let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
let priceAvailable = true;
const userIds: string[] = [];

// Cancelling asks the chain for payments; these chains show none.
function emptyChain(asset: "btc" | "ton"): ChainAdapter {
  return {
    asset,
    requiredConfirmations: 1,
    isValidAddress: () => true,
    canPayOutAs: (receive) => receive === asset,
    newDeposit: async () => {
      throw new Error("deposits come from the real registry here");
    },
    getPayments: async () => [],
    estimateNetworkCost: async () => 0n,
    payout: async () => ({ status: "pending", reason: "not used here" }),
  };
}

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp({
    getPrice: async (coin) => (priceAvailable ? PRICES[coin] : undefined),
    chains: { btc: emptyChain("btc"), ton: emptyChain("ton") },
  }));
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
});

/** A merchant with an API key and the given payout addresses. */
async function merchant(payoutAddresses: Record<string, string>) {
  const userId = randomUUID();
  const apiKey = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    api_key_hash: computeBlindIndex("api-key", apiKey),
    merchant_fee: "0.05",
    payout_addresses: payoutAddresses,
  });
  return { userId, apiKey };
}

async function createInvoice(apiKey: string, body: Record<string, unknown>) {
  return await postJson(`${baseUrl}/invoices`, { amount: "25", ...body }, { merchant_key: apiKey });
}

async function openPage(invoiceId: string) {
  const response = await fetch(`${baseUrl}/pay/${invoiceId}`);
  return { status: response.status, body: await response.json() };
}

async function invoiceInDb(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

describe("the merchant API", () => {
  it("creates a fixed-coin BTC invoice at the current price, with the merchant's payout address", async () => {
    const m = await merchant({ btc: BTC_ADDRESS });

    const response = await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc", underpaid: 2 });

    assert.equal(response.status, 201);
    const invoice = await invoiceInDb(response.body.data.invoiceId);
    assert.equal(invoice?.mode, "fixed");
    assert.equal(invoice?.crypto, "btc");
    assert.equal(invoice?.to_address, BTC_ADDRESS);
    assert.equal(invoice?.underpaid, 2);
    assert.equal(invoice?.amount, "50000"); // $25 at $50,000/BTC = 0.0005 BTC
    assert.ok(invoice?.address);
    assert.ok(invoice?.private?.private_key, "the deposit key is missing");
    assert.equal(invoice?.fee_rate, "0.05", "the merchant's rate was not copied onto the invoice");
  });

  it("creates a fixed-coin TON invoice with a TON deposit, paid out to the merchant's TON address", async () => {
    const m = await merchant({ btc: BTC_ADDRESS, ton: TON_ADDRESS });

    const response = await createInvoice(m.apiKey, { crypto: "ton", to_crypto: "ton" });

    assert.equal(response.status, 201);
    const invoice = await invoiceInDb(response.body.data.invoiceId);
    assert.equal(invoice?.crypto, "ton");
    assert.equal(invoice?.to_crypto, "ton");
    assert.equal(invoice?.to_address, TON_ADDRESS);
    assert.equal(invoice?.amount, "5000000000"); // $25 at $5/TON = 5 TON
    assert.match(invoice?.address ?? "", /^UQ/, "a TON deposit is shown non-bounceable");
    assert.ok(invoice?.private?.private_key, "the deposit key is missing");
    assert.equal(invoice?.fee_rate, "0.05");
  });

  it("refuses a fixed-coin invoice for a deposit coin with no chain adapter, rather than make a BTC one", async () => {
    const m = await merchant({ btc: BTC_ADDRESS, ltc: "LVfF2X4rVkYumLxWRZsK8Z6e1BULNxH5ZW" });

    const response = await createInvoice(m.apiKey, { crypto: "ltc", to_crypto: "ltc" });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "DEPOSIT_COIN_NOT_SUPPORTED");
  });

  it("refuses a TON deposit paid out as another coin", async () => {
    const m = await merchant({ btc: BTC_ADDRESS, ton: TON_ADDRESS });

    const response = await createInvoice(m.apiKey, { crypto: "ton", to_crypto: "btc" });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "PAYOUT_NOT_SUPPORTED");
  });

  it("creates a merchant's-list invoice without a deposit, offering only coins that can be paid end to end", async () => {
    // LTC has no watcher or payout path yet, so it is not offered.
    const m = await merchant({ btc: BTC_ADDRESS, ton: TON_ADDRESS, ltc: "LVfF2X4rVkYumLxWRZsK8Z6e1BULNxH5ZW" });

    const response = await createInvoice(m.apiKey, { mode: "merchant_list" });

    assert.equal(response.status, 201);
    const { invoiceId, link } = response.body.data;
    assert.equal(link, `/pay/${invoiceId}`);
    const invoice = await invoiceInDb(invoiceId);
    assert.equal(invoice?.mode, "merchant_list");
    assert.equal(invoice?.address, "");
    assert.deepEqual([...invoice!.offered_coins].sort(), ["btc", "ton"]);
  });

  it("can narrow the coins offered", async () => {
    const m = await merchant({ btc: BTC_ADDRESS, ton: TON_ADDRESS });

    const response = await createInvoice(m.apiKey, { mode: "merchant_list", coins: ["ton"] });

    assert.deepEqual((await invoiceInDb(response.body.data.invoiceId))?.offered_coins, ["ton"]);
  });

  it("refuses a merchant's-list invoice when no coin can be offered", async () => {
    const m = await merchant({ ltc: "LVfF2X4rVkYumLxWRZsK8Z6e1BULNxH5ZW" });

    const response = await createInvoice(m.apiKey, { mode: "merchant_list" });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "NO_COINS_AVAILABLE");
  });
});

describe("the payer's page", () => {
  async function listInvoice() {
    const m = await merchant({ btc: BTC_ADDRESS, ton: TON_ADDRESS });
    const invoiceId: string = (await createInvoice(m.apiKey, { mode: "merchant_list" })).body.data.invoiceId;
    return { ...m, invoiceId };
  }

  it("shows the price, the coins to pick from, and nothing about the merchant", async () => {
    const { invoiceId, userId } = await listInvoice();

    const page = await openPage(invoiceId);

    assert.equal(page.status, 200);
    assert.equal(page.body.data.amountFiat, "2500");
    assert.deepEqual([...page.body.data.coins].sort(), ["btc", "ton"]);
    assert.equal(page.body.data.payment, null);
    assert.ok(page.body.data.expiresAt);
    const text = JSON.stringify(page.body);
    for (const secret of [userId, BTC_ADDRESS, TON_ADDRESS]) {
      assert.ok(!text.includes(secret), `the page shows ${secret}`);
    }
  });

  it("answers 404 for an unknown or malformed invoice id", async () => {
    assert.equal((await openPage(randomUUID())).status, 404);
    assert.equal((await openPage("not-a-uuid")).status, 404);
  });

  it("lets the payer pick a coin once: deposit address and exact amount at the locked rate", async () => {
    const { invoiceId } = await listInvoice();

    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "ton" });

    assert.equal(choice.status, 200);
    const payment = choice.body.data.payment;
    assert.equal(payment.crypto, "ton");
    assert.equal(payment.amount, "5000000000"); // $25 at $5/TON = 5 TON (9 decimals)
    assert.match(payment.address, /^UQ/);
    const invoice = await invoiceInDb(invoiceId);
    assert.equal(invoice?.crypto, "ton");
    assert.equal(invoice?.to_crypto, "ton");
    assert.equal(invoice?.to_address, TON_ADDRESS);
    assert.ok(invoice?.private?.private_key);

    const again = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "btc" });
    assert.equal(again.status, 409);
    assert.equal((await invoiceInDb(invoiceId))?.crypto, "ton");
  });

  it("refuses a coin that is not offered", async () => {
    const { invoiceId } = await listInvoice();

    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "ltc" });

    assert.equal(choice.status, 409);
    assert.equal((await invoiceInDb(invoiceId))?.crypto, "");
  });

  it("refuses to pick after the invoice expired", async () => {
    const { invoiceId } = await listInvoice();
    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      { $set: { "timestamps.waiting": Date.now() - 31 * 60_000 } },
    );

    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "btc" });

    assert.equal(choice.status, 409);
  });

  it("changes nothing when no price is available", async () => {
    const { invoiceId } = await listInvoice();
    priceAvailable = false;
    try {
      const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "btc" });
      assert.equal(choice.status, 503);
    } finally {
      priceAvailable = true;
    }
    assert.equal((await invoiceInDb(invoiceId))?.crypto, "");
  });

  it("refuses to pick a coin on a fixed-coin invoice", async () => {
    const m = await merchant({ btc: BTC_ADDRESS });
    const invoiceId = (await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc" })).body.data.invoiceId;

    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "btc" });

    assert.equal(choice.status, 409);
  });
});

describe("the payer cancelling", () => {
  it("works while nothing has been paid", async () => {
    const m = await merchant({ btc: BTC_ADDRESS });
    const invoiceId = (await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc" })).body.data.invoiceId;

    const cancel = await postJson(`${baseUrl}/pay/${invoiceId}/cancel`);

    assert.equal(cancel.status, 200);
    const invoice = await invoiceInDb(invoiceId);
    assert.equal(invoice?.status, "cancelled");
    assert.ok(invoice?.timestamps?.cancelled);
  });

  it("is refused once a payment has been seen", async () => {
    const m = await merchant({ btc: BTC_ADDRESS });
    const invoiceId = (await createInvoice(m.apiKey, { crypto: "btc", to_crypto: "btc" })).body.data.invoiceId;
    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      { $set: { status: "underpaid", paid_amount: "1000" } },
    );

    const cancel = await postJson(`${baseUrl}/pay/${invoiceId}/cancel`);

    assert.equal(cancel.status, 409);
    assert.equal((await invoiceInDb(invoiceId))?.status, "underpaid");
  });
});
