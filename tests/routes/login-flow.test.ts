import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { generateTotpCode } from "../../src/auth/totp.function.js";
import { generateRecoveryCredential } from "../../src/security/recovery-credential.js";
import { postJson, registerMerchant, startTestApp } from "../helpers/http-app.js";
import { signChallenge } from "../helpers/recovery-signer.js";

// The login flow: first login with the 12 words, TOTP set up before anything
// else, later logins with account number + TOTP.
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
  await db.collection("login_challenges").deleteMany({ userId: { $in: userIds } });
  await stop();
});

async function newMerchant() {
  const merchant = await registerMerchant(baseUrl);
  userIds.push(merchant.userId);
  return merchant;
}

const cookieOf = (headers: Headers) => headers.getSetCookie()[0]?.split(";")[0];

async function challengeFor(accountNumber: string): Promise<string> {
  const response = await postJson(`${baseUrl}/auth/challenge`, { accountNumber });
  assert.equal(response.status, 200);
  return response.body.data.challenge;
}

async function recoveryLogin(accountNumber: string, recoveryPhrase: string) {
  const challenge = await challengeFor(accountNumber);
  return await postJson(`${baseUrl}/auth/login/recovery`, {
    accountNumber,
    challenge,
    signature: signChallenge(recoveryPhrase, challenge),
  });
}

async function get(path: string, cookie: string) {
  return await fetch(`${baseUrl}${path}`, { headers: { cookie } });
}

/** First login, then TOTP set up: returns the full session and the TOTP secret. */
async function setUpMerchant() {
  const merchant = await newMerchant();
  const first = await recoveryLogin(merchant.accountNumber, merchant.recoveryPhrase);
  const setupCookie = cookieOf(first.headers)!;
  const setup = await postJson(`${baseUrl}/auth/2fa/setup`, {}, { cookie: setupCookie });
  const secret: string = setup.body.data.secret;
  const enable = await postJson(
    `${baseUrl}/auth/2fa/enable`,
    { code: generateTotpCode(secret) },
    { cookie: setupCookie },
  );
  return { merchant, secret, enable, setupCookie, cookie: cookieOf(enable.headers) };
}

describe("registration", () => {
  it("does not log the merchant in", async () => {
    const response = await postJson(`${baseUrl}/auth/register`);
    userIds.push(response.body.data.userId);

    assert.equal(response.status, 201);
    assert.equal(response.headers.getSetCookie().length, 0);
  });
});

describe("first login, before TOTP exists", () => {
  it("is refused with the account number alone", async () => {
    const merchant = await newMerchant();

    const response = await postJson(`${baseUrl}/auth/login`, { accountNumber: merchant.accountNumber });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "RECOVERY_PHRASE_REQUIRED");
    assert.equal(response.headers.getSetCookie().length, 0);
  });

  it("works by signing a challenge with the 12 words, and only allows setting up TOTP", async () => {
    const merchant = await newMerchant();

    const response = await recoveryLogin(merchant.accountNumber, merchant.recoveryPhrase);
    const cookie = cookieOf(response.headers)!;

    assert.equal(response.status, 200);
    assert.equal(response.body.data.next, "totp_setup");
    assert.ok(cookie);
    assert.equal((await get("/auth/session", cookie)).status, 401);
    assert.equal((await postJson(`${baseUrl}/auth/api-key`, {}, { cookie })).status, 401);
    assert.equal((await postJson(`${baseUrl}/auth/2fa/setup`, {}, { cookie })).status, 200);
  });

  it("refuses a signature made with another recovery phrase", async () => {
    const merchant = await newMerchant();

    const response = await recoveryLogin(merchant.accountNumber, generateRecoveryCredential().mnemonic);

    assert.equal(response.status, 401);
    assert.equal(response.headers.getSetCookie().length, 0);
  });

  it("uses each challenge once", async () => {
    const merchant = await newMerchant();
    const challenge = await challengeFor(merchant.accountNumber);
    const body = {
      accountNumber: merchant.accountNumber,
      challenge,
      signature: signChallenge(merchant.recoveryPhrase, challenge),
    };

    assert.equal((await postJson(`${baseUrl}/auth/login/recovery`, body)).status, 200);
    assert.equal((await postJson(`${baseUrl}/auth/login/recovery`, body)).status, 401);
  });

  it("refuses a challenge issued for another account", async () => {
    const victim = await newMerchant();
    const attacker = await newMerchant();
    const challenge = await challengeFor(attacker.accountNumber);

    const response = await postJson(`${baseUrl}/auth/login/recovery`, {
      accountNumber: victim.accountNumber,
      challenge,
      signature: signChallenge(attacker.recoveryPhrase, challenge),
    });

    assert.equal(response.status, 401);
  });

  it("refuses an expired challenge", async () => {
    const merchant = await newMerchant();
    const challenge = await challengeFor(merchant.accountNumber);
    await db.collection("login_challenges").updateMany(
      { userId: merchant.userId },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    const response = await postJson(`${baseUrl}/auth/login/recovery`, {
      accountNumber: merchant.accountNumber,
      challenge,
      signature: signChallenge(merchant.recoveryPhrase, challenge),
    });

    assert.equal(response.status, 401);
  });

  it("gives a challenge even for an unknown account, so accounts can't be probed", async () => {
    const response = await postJson(`${baseUrl}/auth/challenge`, { accountNumber: "1234-5678-9012-3456" });

    assert.equal(response.status, 200);
    assert.ok(response.body.data.challenge);
  });
});

describe("setting up TOTP", () => {
  it("needs one valid code, then turns the session into a full one", async () => {
    const { enable, setupCookie, cookie } = await setUpMerchant();

    assert.equal(enable.status, 200);
    assert.ok(cookie && cookie !== setupCookie);
    assert.equal((await get("/auth/session", setupCookie)).status, 401, "the setup session still works");
    const session = await get("/auth/session", cookie!);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).data.twoFactorEnabled, true);
  });

  it("does not switch TOTP on with a wrong code", async () => {
    const merchant = await newMerchant();
    const cookie = cookieOf((await recoveryLogin(merchant.accountNumber, merchant.recoveryPhrase)).headers)!;
    await postJson(`${baseUrl}/auth/2fa/setup`, {}, { cookie });

    const enable = await postJson(`${baseUrl}/auth/2fa/enable`, { code: "000000" }, { cookie });

    assert.equal(enable.status, 409);
    const user = await db.collection("users").findOne({ user_id: merchant.userId });
    assert.equal(user?.totp_enabled, false);
  });
});

describe("later logins", () => {
  it("take the account number, then a TOTP code", async () => {
    const { merchant, secret } = await setUpMerchant();

    const login = await postJson(`${baseUrl}/auth/login`, { accountNumber: merchant.accountNumber });
    const pending = cookieOf(login.headers)!;
    assert.equal(login.status, 200);
    assert.equal(login.body.data.requiredTwoFactor, true);
    assert.equal((await get("/auth/session", pending)).status, 401);

    // The next 30-second step: the code used to enable TOTP can't be replayed.
    const code = generateTotpCode(secret, new Date(Date.now() + 30_000));
    const verify = await postJson(`${baseUrl}/auth/2fa/verify`, { code }, { cookie: pending });

    assert.equal(verify.status, 200);
    assert.equal((await get("/auth/session", cookieOf(verify.headers)!)).status, 200);
  });

  it("no longer accept the 12 words once TOTP is on", async () => {
    const { merchant } = await setUpMerchant();

    const response = await recoveryLogin(merchant.accountNumber, merchant.recoveryPhrase);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "USE_TOTP_LOGIN");
  });

  it("refuse an old full session of a merchant without TOTP", async () => {
    const merchant = await newMerchant();
    const { createSession } = await import("../../src/sessions/session.repository.js");
    const { token } = await createSession({
      userId: merchant.userId,
      status: "active",
      ipAddress: null,
      userAgent: null,
    });

    assert.equal((await get("/auth/session", `session=${token}`)).status, 401);
  });
});
