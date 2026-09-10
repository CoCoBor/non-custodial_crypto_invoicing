import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";
import { connectToMongoDb, disconnectFromMongoDB } from "../../src/infrastructure/database/mongodb.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";
import { openSecret } from "../../src/security/secret-envelope.js";
import { derivePublicKeyFromMnemonic } from "../../src/security/recovery-credential.js";

test("registration creates a v2 merchant that can log in without leaking stored credentials", async () => {
  const db = await connectToMongoDb();
  const server = createApp().listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let lookup: string | undefined;
  try {
    const response = await fetch(`${url}/auth/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ merchant_fee: 0, merchant_key: "attacker", totp_enabled: true }) });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.match(body.data.accountNumber, /^\d{16}$/);
    lookup = computeBlindIndex("account-number", body.data.accountNumber);
    const user = await db.collection("users").findOne({ account_hash: lookup });
    assert.ok(user, "registration must store the merchant in users");
    assert.match(user.user_id, /^[0-9a-f-]{36}$/);
    assert.match(
      user.merchant_key,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    // Two separate randomUUID() calls: an api key that equals the public user
    // id would leak one from the other.
    assert.notEqual(user.merchant_key, user.user_id);
    assert.equal(user.merchant_fee, 0.005);
    assert.equal(user.totp_enabled, false);
    assert.equal(user.totp_secret, null);
    assert.deepEqual(user.invoices, []);
    assert.equal(user.payout_addresses.btc, "");
    assert.equal(user.accountNumber, undefined);
    assert.equal(user.accountNumberCipher, undefined);
    assert.equal(body.data.recoveryPhrase.split(" ").length, 12);
    const recoveryPublicKey = derivePublicKeyFromMnemonic(
      body.data.recoveryPhrase,
    );
    assert.ok(recoveryPublicKey);
    assert.equal(user.recovery_public_key, recoveryPublicKey);
    // The phrase itself is the merchant's alone; only the public half is kept.
    assert.equal(user.recoveryPhrase, undefined);
    assert.equal(user.mnemonic, undefined);
    const sealed = user.account_number_cipher;
    assert.ok(sealed, "the account number must be stored sealed, not dropped");
    // Read through the native driver, so `select: false` does not apply and
    // the sealed fields arrive as plain Buffers.
    const recoveredAccountNumber = openSecret("account-number", {
      keyVersion: sealed.keyVersion,
      initialisationVector: sealed.initialisationVector,
      authenticationTag: sealed.authenticationTag,
      ciphertext: sealed.ciphertext,
    });
    // Stronger than asserting a cipher field exists: it proves what comes back
    // out of the database is the number the merchant was actually given.
    assert.equal(recoveredAccountNumber, body.data.accountNumber);
    assert.deepEqual(Object.keys(body.data).sort(), ["accountNumber", "accountNumberDisplay", "recoveryPhrase", "userId"]);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const login = await fetch(`${url}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountNumber: body.data.accountNumberDisplay }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).data.requiresTwoFactor, false);
    const cookie = login.headers.getSetCookie()[0]?.split(";")[0];
    assert.ok(cookie);
    const session = await fetch(`${url}/auth/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal(sessionBody.data.userId, user.user_id);
    assert.equal(sessionBody.data.twoFactorEnabled, false);
    assert.equal(sessionBody.data.accountNumber, undefined);
    assert.equal(sessionBody.data.account_hash, undefined);
    assert.equal(sessionBody.data.totp_secret, undefined);
    // A session is re-openable from a cookie, so it must never re-serve the
    // one-time onboarding secrets.
    assert.equal(sessionBody.data.recoveryPhrase, undefined);
    assert.equal(sessionBody.data.recovery_public_key, undefined);
    assert.equal(sessionBody.data.account_number_cipher, undefined);
    assert.equal(sessionBody.data.merchant_key, undefined);
    const setup = await fetch(`${url}/auth/2fa/setup`, { method: "POST", headers: { cookie } });
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    // A freshly registered merchant can start enrolment straight away, and the
    // otpauth uri is keyed to the public uuid rather than the internal _id.
    assert.match(setupBody.data.secret, /^[A-Z2-7]+=*$/);
    assert.ok(String(setupBody.data.uri).startsWith("otpauth://totp/"));
    assert.ok(String(setupBody.data.uri).includes(user.user_id));
    const logout = await fetch(`${url}/auth/logout`, { method: "POST", headers: { cookie } });
    assert.equal(logout.status, 200);
    const expired = await fetch(`${url}/auth/session`, { headers: { cookie } });
    assert.equal(expired.status, 401);
  } finally {
    if (lookup) {
      const user = await db.collection("users").findOne({ account_hash: lookup });
      if (user) await db.collection("sessions").deleteMany({ accountId: user._id });
      await db.collection("users").deleteOne({ account_hash: lookup });
      // Also remove the legacy fixture if the initial red test hit the old route.
      await db.collection("accounts").deleteOne({ accountNumberLookup: lookup });
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await disconnectFromMongoDB();
  }
});
