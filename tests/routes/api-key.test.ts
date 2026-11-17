import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { computeBlindIndex } from "../../src/security/blind-index.js";
import { logIn, postJson, registerMerchant, startTestApp } from "../helpers/http-app.js";

// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp());
});

after(async () => {
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await db.collection("sessions").deleteMany({ userId: { $in: userIds } });
  await stop();
});

async function loggedInMerchant() {
  const merchant = await registerMerchant(baseUrl);
  userIds.push(merchant.userId);
  const { cookie } = await logIn(baseUrl, merchant);
  return { ...merchant, cookie };
}

async function makeApiKey(cookie: string) {
  return await postJson(`${baseUrl}/auth/api-key`, {}, { cookie });
}

async function createInvoiceWith(apiKey: string) {
  return await postJson(
    `${baseUrl}/invoices`,
    { amount: "25", crypto: "btc", to_crypto: "btc" },
    { merchant_key: apiKey },
  );
}

describe("API keys", () => {
  it("a new merchant has no API key until they make one", async () => {
    const merchant = await loggedInMerchant();
    const user = await db.collection("users").findOne({ user_id: merchant.userId });

    assert.ok(user);
    assert.ok(!user.merchant_key, "a plain key was stored at registration");
    assert.ok(!user.api_key_hash);
  });

  it("making a key shows it once and stores only its keyed hash", async () => {
    const merchant = await loggedInMerchant();

    const response = await makeApiKey(merchant.cookie);

    assert.equal(response.status, 201);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const apiKey: string = response.body.data.apiKey;
    assert.match(apiKey, UUID_V4);
    // Two separate randomUUID() calls: an api key that equals the public user
    // id would leak one from the other.
    assert.notEqual(apiKey, merchant.userId);

    const user = await db.collection("users").findOne({ user_id: merchant.userId });
    assert.equal(user?.api_key_hash, computeBlindIndex("api-key", apiKey));
    assert.ok(!JSON.stringify(user).includes(apiKey), "the plain key is stored somewhere");
  });

  it("the key lets the shop create invoices", async () => {
    const merchant = await loggedInMerchant();
    const apiKey = (await makeApiKey(merchant.cookie)).body.data.apiKey;

    const response = await createInvoiceWith(apiKey);

    // Past authentication; refused only because no payout address is saved.
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "PAYOUT_ADDRESS_REQUIRED");
  });

  it("making a new key stops the old one at once", async () => {
    const merchant = await loggedInMerchant();
    const oldKey = (await makeApiKey(merchant.cookie)).body.data.apiKey;
    const newKey = (await makeApiKey(merchant.cookie)).body.data.apiKey;

    assert.notEqual(oldKey, newKey);
    assert.equal((await createInvoiceWith(oldKey)).status, 401);
    assert.equal((await createInvoiceWith(newKey)).status, 409);
  });

  it("refuses an unknown key", async () => {
    assert.equal((await createInvoiceWith("6a3b0c2e-1111-4222-8333-444455556666")).status, 401);
  });

  it("needs a logged-in merchant to make a key", async () => {
    assert.equal((await makeApiKey("session=not-a-real-session")).status, 401);
  });

  it("a key cannot open the dashboard", async () => {
    const merchant = await loggedInMerchant();
    const apiKey = (await makeApiKey(merchant.cookie)).body.data.apiKey;

    const session = await fetch(`${baseUrl}/auth/session`, { headers: { merchant_key: apiKey } });
    const newKey = await postJson(`${baseUrl}/auth/api-key`, {}, { merchant_key: apiKey });

    assert.equal(session.status, 401);
    assert.equal(newKey.status, 401);
  });
});
