import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { computeBlindIndex } from "../../src/security/blind-index.js";
import { unusedSwap } from "../helpers/fake-swap.js";
import { postJson, startTestApp } from "../helpers/http-app.js";

// Spec story 52: the payer is sent back to the shop after paying. The shop
// sets return_url when it creates the invoice; the payer's page hands it out
// once the payer is done (paid, or the invoice expired or was cancelled).
// Story 75: it is never proof of payment, so nothing about the payment is added to it.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test.

const BTC_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const RETURN_URL = "https://shop.example/thanks?order=42";

let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp({
    getPrice: async (coin) => ({ btc: "50000" })[coin as string],
    swap: unusedSwap(),
  }));
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
});

async function merchant() {
  const userId = randomUUID();
  const apiKey = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    api_key_hash: computeBlindIndex("api-key", apiKey),
    merchant_fee: "0.05",
    payout_addresses: { btc: BTC_ADDRESS },
  });
  return { userId, apiKey };
}

const FIXED = { amount: "25", crypto: "btc", to_crypto: "btc" };

async function createInvoice(apiKey: string, body: Record<string, unknown>) {
  return await postJson(`${baseUrl}/invoices`, body, { merchant_key: apiKey });
}

async function payerPage(invoiceId: string) {
  return (await (await fetch(`${baseUrl}/pay/${invoiceId}`)).json()).data;
}

describe("return_url at invoice creation", () => {
  it("is stored and echoed for a fixed-coin invoice", async () => {
    const m = await merchant();

    const response = await createInvoice(m.apiKey, { ...FIXED, return_url: RETURN_URL });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.returnUrl, RETURN_URL);
    const invoice = await db.collection("invoices").findOne({ invoice_id: response.body.data.invoiceId });
    assert.equal(invoice?.return_url, RETURN_URL);
  });

  it("is stored for a merchant's-list invoice", async () => {
    const m = await merchant();

    const response = await createInvoice(m.apiKey, { amount: "25", mode: "merchant_list", return_url: RETURN_URL });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.returnUrl, RETURN_URL);
    const invoice = await db.collection("invoices").findOne({ invoice_id: response.body.data.invoiceId });
    assert.equal(invoice?.return_url, RETURN_URL);
  });

  it("is optional", async () => {
    const m = await merchant();

    const response = await createInvoice(m.apiKey, FIXED);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.returnUrl, null);
  });

  const refused: [string, unknown][] = [
    ["a javascript: URL", "javascript:alert(document.cookie)"],
    ["a JavaScript: URL in mixed case", "JavaScript:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["plain http", "http://shop.example/thanks"],
    ["another scheme", "ftp://shop.example/thanks"],
    ["a URL with credentials", "https://user:secret@shop.example/thanks"],
    ["a relative path", "/thanks"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["one over 2048 characters", `https://shop.example/${"a".repeat(2048 - "https://shop.example/".length + 1)}`],
  ];
  for (const [name, value] of refused) {
    it(`refuses ${name}, and creates nothing`, async () => {
      const m = await merchant();

      const response = await createInvoice(m.apiKey, { ...FIXED, return_url: value });

      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "INVALID_REQUEST");
      assert.equal(await db.collection("invoices").countDocuments({ user_id: m.userId }), 0);
    });
  }

  it("accepts one of exactly 2048 characters", async () => {
    const m = await merchant();
    const url = `https://shop.example/${"a".repeat(2048 - "https://shop.example/".length)}`;

    const response = await createInvoice(m.apiKey, { ...FIXED, return_url: url });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.returnUrl, url);
  });
});

describe("return_url on the payer's page", () => {
  async function invoiceIn(status: string, extra: Record<string, unknown> = { return_url: RETURN_URL }) {
    const m = await merchant();
    const created = await createInvoice(m.apiKey, { ...FIXED, ...extra });
    assert.equal(created.status, 201);
    const invoiceId: string = created.body.data.invoiceId;
    await db.collection("invoices").updateOne({ invoice_id: invoiceId }, { $set: { status } });
    return invoiceId;
  }

  for (const status of ["waiting", "underpaid", "confirming"]) {
    it(`is withheld while the invoice is ${status}`, async () => {
      assert.equal((await payerPage(await invoiceIn(status))).returnUrl, null);
    });
  }

  for (const status of ["confirmed", "processing", "completed", "failed", "expired", "cancelled"]) {
    it(`is given once the invoice is ${status}`, async () => {
      assert.equal((await payerPage(await invoiceIn(status))).returnUrl, RETURN_URL);
    });
  }

  it("is null when the invoice has none", async () => {
    assert.equal((await payerPage(await invoiceIn("completed", {}))).returnUrl, null);
  });
});
