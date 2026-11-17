import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { hashPlainMerchantKeys } from "../../src/scripts/hash-merchant-keys.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";
import { postJson, startTestApp } from "../helpers/http-app.js";

// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp());
});

after(async () => {
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
});

async function userWith(fields: Record<string, unknown>) {
  const userId = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({ user_id: userId, ...fields });
  return userId;
}

describe("moving plain API keys to keyed hashes", () => {
  it("keeps an already-issued key working and removes the plain copy", async () => {
    const plainKey = randomUUID();
    const userId = await userWith({ merchant_key: plainKey });

    await hashPlainMerchantKeys(db);

    const user = await db.collection("users").findOne({ user_id: userId });
    assert.equal(user?.api_key_hash, computeBlindIndex("api-key", plainKey));
    assert.ok(!("merchant_key" in user!));
    const invoice = await postJson(
      `${baseUrl}/invoices`,
      { amount: "25", crypto: "btc", to_crypto: "btc" },
      { merchant_key: plainKey },
    );
    assert.notEqual(invoice.status, 401);
  });

  it("drops a plain key when the merchant already has a newer one", async () => {
    const newerHash = computeBlindIndex("api-key", randomUUID());
    const userId = await userWith({ merchant_key: randomUUID(), api_key_hash: newerHash });

    await hashPlainMerchantKeys(db);

    const user = await db.collection("users").findOne({ user_id: userId });
    assert.equal(user?.api_key_hash, newerHash);
    assert.ok(!("merchant_key" in user!));
  });

  it("is safe to run twice", async () => {
    const plainKey = randomUUID();
    const userId = await userWith({ merchant_key: plainKey });

    await hashPlainMerchantKeys(db);
    await hashPlainMerchantKeys(db);

    const user = await db.collection("users").findOne({ user_id: userId });
    assert.equal(user?.api_key_hash, computeBlindIndex("api-key", plainKey));
  });
});
