import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { ACCOUNTS_COLLECTION } from "../../src/accounts/account.model.js";
import { createApp } from "../../src/app.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";

let database: Db;
let server: Server;
let baseUrl: string;

const createdLookups: string[] = [];

interface RegisterResponse {
  data: {
    accountNumber: string;
    accountNumberDisplay: string;
    recoveryPhrase: string;
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
  await ensureIndexes(database);

  server = createApp().listen(0);
  await once(server, "listening");

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (createdLookups.length > 0) {
    await database
      .collection(ACCOUNTS_COLLECTION)
      .deleteMany({ accountNumberLookup: { $in: createdLookups } });
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

  it("returns a 24 word recovery phrase", async () => {
    assert.equal(
      (await register()).body.data.recoveryPhrase.split(" ").length,
      24,
    );
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

    const found = await database.collection(ACCOUNTS_COLLECTION).findOne({
      accountNumberLookup: computeBlindIndex(
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
      first.body.data.recoveryPhrase,
      second.body.data.recoveryPhrase,
    );
  });

  it("does not leak internal database fields", async () => {
    const keys = Object.keys((await register()).body.data).sort();

    assert.deepEqual(keys, [
      "accountNumber",
      "accountNumberDisplay",
      "recoveryPhrase",
    ]);
  });

  it("does not answer GET", async () => {
    const response = await fetch(`${baseUrl}/auth/register`);

    assert.equal(response.status, 404);
  });
});
