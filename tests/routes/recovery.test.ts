import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { generateTotpCode } from "../../src/auth/totp.function.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";
import {
  derivePublicKeyFromMnemonic,
  generateRecoveryCredential,
} from "../../src/security/recovery-credential.js";
import { openSecret } from "../../src/security/secret-envelope.js";
import { logIn, postJson, registerMerchant, startTestApp } from "../helpers/http-app.js";
import { signChallenge } from "../helpers/recovery-signer.js";

// Recovery with the 12 words: reset TOTP, or get a new account number.
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

const cookieOf = (headers: Headers) => headers.getSetCookie()[0]?.split(";")[0];

/** A merchant who finished the first login and set up TOTP. */
async function establishedMerchant() {
  const merchant = await registerMerchant(baseUrl);
  userIds.push(merchant.userId);
  const { cookie, totpSecret } = await logIn(baseUrl, merchant);
  return { ...merchant, cookie, totpSecret };
}

/** What the browser does: only the 12 words are needed, not the account number. */
async function recover(path: string, recoveryPhrase: string) {
  const recoveryPublicKey = derivePublicKeyFromMnemonic(recoveryPhrase)!;
  const challenge = (await postJson(`${baseUrl}/auth/challenge`, { recoveryPublicKey })).body.data.challenge;
  return await postJson(`${baseUrl}/auth/recovery/${path}`, {
    recoveryPublicKey,
    challenge,
    signature: signChallenge(recoveryPhrase, challenge),
  });
}

async function sessionStatus(cookie: string) {
  return (await fetch(`${baseUrl}/auth/session`, { headers: { cookie } })).status;
}

describe("resetting TOTP with the 12 words", () => {
  it("switches TOTP off, ends every session, and lets the merchant set up a new device", async () => {
    const merchant = await establishedMerchant();

    const reset = await recover("reset-totp", merchant.recoveryPhrase);

    assert.equal(reset.status, 200);
    assert.equal(reset.body.data.next, "totp_setup");
    assert.equal(await sessionStatus(merchant.cookie), 401, "an old session still works");
    const user = await db.collection("users").findOne({ user_id: merchant.userId });
    assert.equal(user?.totp_enabled, false);

    const setupCookie = cookieOf(reset.headers)!;
    const secret = (await postJson(`${baseUrl}/auth/2fa/setup`, {}, { cookie: setupCookie })).body.data.secret;
    assert.notEqual(secret, merchant.totpSecret);
    const enable = await postJson(`${baseUrl}/auth/2fa/enable`, { code: generateTotpCode(secret) }, { cookie: setupCookie });
    assert.equal(enable.status, 200);
    assert.equal(await sessionStatus(cookieOf(enable.headers)!), 200);
  });

  it("is refused for another recovery phrase, and changes nothing", async () => {
    const merchant = await establishedMerchant();
    const stranger = generateRecoveryCredential().mnemonic;
    const recoveryPublicKey = derivePublicKeyFromMnemonic(merchant.recoveryPhrase)!;
    const challenge = (await postJson(`${baseUrl}/auth/challenge`, { recoveryPublicKey })).body.data.challenge;

    const reset = await postJson(`${baseUrl}/auth/recovery/reset-totp`, {
      recoveryPublicKey,
      challenge,
      signature: signChallenge(stranger, challenge),
    });

    assert.equal(reset.status, 401);
    assert.equal(await sessionStatus(merchant.cookie), 200);
    assert.equal((await db.collection("users").findOne({ user_id: merchant.userId }))?.totp_enabled, true);
  });
});

describe("a new account number from the 12 words", () => {
  it("is shown once, works for login, and the old number stops working", async () => {
    const merchant = await establishedMerchant();

    const response = await recover("new-account-number", merchant.recoveryPhrase);

    assert.equal(response.status, 201);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const { accountNumber, accountNumberDisplay } = response.body.data;
    assert.match(accountNumber, /^\d{16}$/);
    assert.notEqual(accountNumber, merchant.accountNumber);
    assert.equal(accountNumberDisplay.replaceAll("-", ""), accountNumber);

    assert.equal(await sessionStatus(merchant.cookie), 401, "an old session still works");
    const oldLogin = await postJson(`${baseUrl}/auth/login`, { accountNumber: merchant.accountNumber });
    assert.equal(oldLogin.status, 401);
    const newLogin = await postJson(`${baseUrl}/auth/login`, { accountNumber });
    assert.equal(newLogin.status, 200);
    assert.equal(newLogin.body.data.requiredTwoFactor, true);
  });

  it("is stored like the first one: a keyed hash and a sealed copy", async () => {
    const merchant = await establishedMerchant();

    const { accountNumber } = (await recover("new-account-number", merchant.recoveryPhrase)).body.data;

    const user = await db.collection("users").findOne({ user_id: merchant.userId });
    assert.equal(user?.account_hash, computeBlindIndex("account-number", accountNumber));
    const sealed = user!.account_number_cipher;
    assert.equal(
      openSecret("account-number", {
        keyVersion: sealed.keyVersion,
        // The connection promotes binary fields to plain Buffers.
        initialisationVector: sealed.initialisationVector,
        authenticationTag: sealed.authenticationTag,
        ciphertext: sealed.ciphertext,
      }),
      accountNumber,
    );
  });

  it("is refused for another recovery phrase", async () => {
    const merchant = await establishedMerchant();
    const recoveryPublicKey = derivePublicKeyFromMnemonic(merchant.recoveryPhrase)!;
    const challenge = (await postJson(`${baseUrl}/auth/challenge`, { recoveryPublicKey })).body.data.challenge;

    const response = await postJson(`${baseUrl}/auth/recovery/new-account-number`, {
      recoveryPublicKey,
      challenge,
      signature: signChallenge(generateRecoveryCredential().mnemonic, challenge),
    });

    assert.equal(response.status, 401);
    assert.equal((await postJson(`${baseUrl}/auth/login`, { accountNumber: merchant.accountNumber })).status, 200);
  });
});

describe("challenges by recovery public key", () => {
  it("are given for an unknown key too, so keys can't be probed", async () => {
    const recoveryPublicKey = derivePublicKeyFromMnemonic(generateRecoveryCredential().mnemonic)!;

    const response = await postJson(`${baseUrl}/auth/challenge`, { recoveryPublicKey });

    assert.equal(response.status, 200);
    assert.ok(response.body.data.challenge);
  });
});
