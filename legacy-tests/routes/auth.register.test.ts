import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { USERS_COLLECTION, User } from "../../src/accounts/user.model.js";
import { createApp } from "../../src/app.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";
import { derivePublicKeyFromMnemonic } from "../../src/security/recovery-credential.js";

let database: Db;
let server: Server;
let baseUrl: string;

const createdLookups: string[] = [];

interface RegisterResponse {
  data: {
    accountNumber: string;
    accountNumberDisplay: string;
    recoveryPhrase: string;
    userId: string;
  };
}

async function register(): Promise<{
  status: number;
  headers: Headers;
  body: RegisterResponse;
}> {
  const response = await fetch(`${baseUrl}/auth/register`, { method: "POST" });
  const body = (await response.json()) as RegisterResponse;

  if (body.data?.accountNumber) {
    createdLookups.push(
      computeBlindIndex("account-number", body.data.accountNumber),
    );
  }

  return { status: response.status, headers: response.headers, body };
}

before(async () => {
  database = await connectToMongoDb();
  await User.createIndexes();

  server = createApp().listen(0);
  await once(server, "listening");

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (createdLookups.length > 0) {
    await database
      .collection(USERS_COLLECTION)
      .deleteMany({ account_hash: { $in: createdLookups } });
  }

  server.close();
  await once(server, "close");
  await disconnectFromMongoDB();
});

describe("POST /auth/register", () => {
  it("responds 201 Created", async () => {
    assert.equal((await register()).status, 201);
  });

  it("wraps the payload in the data envelope used across the api", async () => {
    assert.deepEqual(Object.keys((await register()).body), ["data"]);
  });

  it("returns a 16 digit account number", async () => {
    assert.match((await register()).body.data.accountNumber, /^[0-9]{16}$/);
  });

  it("returns the account number formatted for display", async () => {
    const { data } = (await register()).body;

    assert.equal(
      data.accountNumberDisplay.replaceAll("-", ""),
      data.accountNumber,
    );
    assert.match(data.accountNumberDisplay, /^\d{4}-\d{4}-\d{4}-\d{4}$/);
  });

  it("returns a 12 word recovery phrase for the merchant to write down", async () => {
    const { recoveryPhrase } = (await register()).body.data;

    assert.equal(recoveryPhrase.split(" ").length, 12);
    // A phrase the server cannot derive a key from is a phrase that can never
    // recover the account, so it has to be checked here and not only on use.
    assert.ok(derivePublicKeyFromMnemonic(recoveryPhrase));
  });

  it("issues a different recovery phrase to every merchant", async () => {
    assert.notEqual(
      (await register()).body.data.recoveryPhrase,
      (await register()).body.data.recoveryPhrase,
    );
  });

  it("returns a public UUID", async () => {
    assert.match((await register()).body.data.userId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("tells caches and proxies never to store the response", async () => {
    const { headers } = await register();

    assert.match(
      headers.get("cache-control") ?? "",
      /no-store/,
      "a response carrying secrets must not be cacheable",
    );
  });

  it("actually persists an account that can be found by blind index", async () => {
    const { body } = await register();

    const found = await database.collection(USERS_COLLECTION).findOne({
      account_hash: computeBlindIndex(
        "account-number",
        body.data.accountNumber,
      ),
    });

    assert.ok(found, "the account was returned but never stored");
  });

  it("creates a different account on every call", async () => {
    const first = await register();
    const second = await register();

    assert.notEqual(
      first.body.data.accountNumber,
      second.body.data.accountNumber,
    );
    assert.notEqual(
      first.body.data.userId,
      second.body.data.userId,
    );
    assert.notEqual(
      first.body.data.recoveryPhrase,
      second.body.data.recoveryPhrase,
    );
  });

  it("never stores the recovery phrase it handed out", async () => {
    const { body } = await register();

    const found = await database.collection(USERS_COLLECTION).findOne({
      account_hash: computeBlindIndex(
        "account-number",
        body.data.accountNumber,
      ),
    });
    const stored = JSON.stringify(found);

    // Holding the phrase would make the server able to spend on the merchant's
    // behalf, which is the whole property the non-custodial design rests on.
    assert.ok(!stored.includes(body.data.recoveryPhrase));

    // Checking adjacent pairs rather than single words: a stored phrase always
    // carries at least one pair, while a lone word like "art" or "able" would
    // match by chance inside a base64 key and make this fail on good data.
    const words = body.data.recoveryPhrase.split(" ");
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]} ${words[i + 1]}`;
      assert.ok(!stored.includes(pair), `the recovery phrase leaked: "${pair}"`);
    }
    assert.ok(!stored.includes(body.data.accountNumber));
  });

  it("stores only the public key derived from the phrase", async () => {
    const { body } = await register();

    const found = await database.collection(USERS_COLLECTION).findOne({
      account_hash: computeBlindIndex(
        "account-number",
        body.data.accountNumber,
      ),
    });

    assert.equal(
      found?.recovery_public_key,
      derivePublicKeyFromMnemonic(body.data.recoveryPhrase),
    );
  });

  it("does not leak internal database fields", async () => {
    const keys = Object.keys((await register()).body.data).sort();

    assert.deepEqual(keys, [
      "accountNumber",
      "accountNumberDisplay",
      "recoveryPhrase",
      "userId",
    ]);
  });

  it("does not answer GET", async () => {
    const response = await fetch(`${baseUrl}/auth/register`);

    assert.equal(response.status, 404);
  });
});
