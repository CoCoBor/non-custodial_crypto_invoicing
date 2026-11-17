import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { logIn, postJson, registerMerchant, startTestApp } from "../helpers/http-app.js";
import { freshTotpCode } from "../helpers/totp.js";

// The secret the merchant's server uses to check our webhook signatures.
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
  await db.collection("sessions").deleteMany({ userId: { $in: userIds } });
  await stop();
});

async function merchant() {
  const registered = await registerMerchant(baseUrl);
  userIds.push(registered.userId);
  const { cookie, totpSecret } = await logIn(baseUrl, registered);
  return { cookie, code: () => freshTotpCode(db, registered.userId, totpSecret), userId: registered.userId };
}

async function setWebhookUrl(m: Awaited<ReturnType<typeof merchant>>, url: string) {
  const response = await fetch(`${baseUrl}/settings/webhook-url`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: m.cookie },
    body: JSON.stringify({ url, totpCode: await m.code() }),
  });
  return { status: response.status, body: await response.json() };
}

describe("the webhook signing secret", () => {
  it("is shown once, when the first webhook URL is set", async () => {
    const m = await merchant();

    const first = await setWebhookUrl(m, "https://shop.example/hook");
    const second = await setWebhookUrl(m, "https://shop.example/other");

    assert.equal(first.status, 200);
    assert.match(first.body.data.secret, /^whsec_[A-Za-z0-9_-]{32}$/);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.secret, undefined);
    const user = await db.collection("users").findOne({ user_id: m.userId });
    assert.ok(user?.webhook_secret, "the secret is not stored");
    assert.ok(!JSON.stringify(user).includes(first.body.data.secret), "the secret is stored in plain text");
  });

  it("can be replaced with a TOTP code", async () => {
    const m = await merchant();
    const original = (await setWebhookUrl(m, "https://shop.example/hook")).body.data.secret;

    const without = await postJson(`${baseUrl}/settings/webhook-secret`, {}, { cookie: m.cookie });
    const replaced = await postJson(`${baseUrl}/settings/webhook-secret`, { totpCode: await m.code() }, { cookie: m.cookie });

    assert.equal(without.status, 401);
    assert.equal(replaced.status, 201);
    assert.match(replaced.body.data.secret, /^whsec_/);
    assert.notEqual(replaced.body.data.secret, original);
  });
});
