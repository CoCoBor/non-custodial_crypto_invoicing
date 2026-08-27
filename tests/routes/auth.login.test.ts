import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db, ObjectId } from "mongodb";

import {
  ACCOUNTS_COLLECTION,
  type AccountDocument,
} from "../../src/accounts/account.model.js";
import { createAccount } from "../../src/accounts/account.repository.js";
import { createApp } from "../../src/app.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { hashBearerToken } from "../../src/security/secret-generator.js";
import { sealSecret } from "../../src/security/secret-envelope.js";
import {
  SESSIONS_COLLECTION,
  type SessionDocument,
} from "../../src/sessions/session.model.js";

const COOKIE_NAME = "session";

let database: Db;
let server: Server;
let baseUrl: string;

const createdAccountIds: ObjectId[] = [];

async function newAccount() {
  const account = await createAccount(database);
  createdAccountIds.push(account.accountId);

  return account;
}

async function login(body: unknown) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as {
      data?: { requiresTwoFactor: boolean };
      error?: { code: string; message: string };
    },
  };
}

function sessionTokenFrom(headers: Headers): string | undefined {
  const cookie = headers
    .getSetCookie()
    .find((value) => value.startsWith(`${COOKIE_NAME}=`));

  return cookie?.split(";")[0]?.slice(COOKIE_NAME.length + 1) || undefined;
}

before(async () => {
  database = await connectToMongoDb();
  await ensureIndexes(database);

  server = createApp().listen(0);
  await once(server, "listening");

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (createdAccountIds.length > 0) {
    await database
      .collection(SESSIONS_COLLECTION)
      .deleteMany({ accountId: { $in: createdAccountIds } });
    await database
      .collection(ACCOUNTS_COLLECTION)
      .deleteMany({ _id: { $in: createdAccountIds } });
  }

  server.close();
  await once(server, "close");
  await disconnectFromMongoDB();
});

describe("POST /auth/login with a valid account number", () => {
  it("responds 200 and reports that no second factor is needed", async () => {
    const account = await newAccount();
    const response = await login({ accountNumber: account.accountNumber });

    assert.equal(response.status, 200);
    assert.equal(response.body.data?.requiresTwoFactor, false);
  });

  it("accepts the dashed display format the user is shown", async () => {
    const account = await newAccount();
    const dashed = account.accountNumber.replace(
      /(\d{4})(\d{4})(\d{4})(\d{4})/,
      "$1-$2-$3-$4",
    );

    assert.equal((await login({ accountNumber: dashed })).status, 200);
  });

  it("accepts spaces as well", async () => {
    const account = await newAccount();
    const spaced = account.accountNumber.replace(
      /(\d{4})(\d{4})(\d{4})(\d{4})/,
      "$1 $2 $3 $4",
    );

    assert.equal((await login({ accountNumber: spaced })).status, 200);
  });

  it("sets a session cookie that javascript cannot read", async () => {
    const account = await newAccount();
    const { headers } = await login({ accountNumber: account.accountNumber });

    const cookie = headers
      .getSetCookie()
      .find((value) => value.startsWith(`${COOKIE_NAME}=`));

    assert.ok(cookie, "no session cookie was set");
    assert.match(cookie, /HttpOnly/i, "the cookie must be HttpOnly");
    assert.match(cookie, /SameSite=(Strict|Lax)/i, "the cookie needs SameSite");
    assert.match(cookie, /Path=\//i, "the cookie needs an explicit path");
  });

  it("stores a session that resolves back to the account", async () => {
    const account = await newAccount();
    const { headers } = await login({ accountNumber: account.accountNumber });

    const token = sessionTokenFrom(headers);
    assert.ok(token, "no token in the cookie");

    const session = await database
      .collection<SessionDocument>(SESSIONS_COLLECTION)
      .findOne({ tokenHash: hashBearerToken(decodeURIComponent(token)) });

    assert.ok(session, "the cookie token matches no stored session");
    assert.equal(String(session.accountId), String(account.accountId));
    assert.equal(session.status, "active");
  });

  it("never puts the raw token in the response body", async () => {
    const account = await newAccount();
    const response = await login({ accountNumber: account.accountNumber });
    const token = sessionTokenFrom(response.headers);

    assert.ok(token);
    assert.ok(!JSON.stringify(response.body).includes(token));
  });

  it("tells caches never to store the response", async () => {
    const account = await newAccount();
    const { headers } = await login({ accountNumber: account.accountNumber });

    assert.match(headers.get("cache-control") ?? "", /no-store/);
  });

  it("issues a fresh session on every login", async () => {
    const account = await newAccount();

    const first = sessionTokenFrom(
      (await login({ accountNumber: account.accountNumber })).headers,
    );
    const second = sessionTokenFrom(
      (await login({ accountNumber: account.accountNumber })).headers,
    );

    assert.notEqual(first, second);
  });
});

describe("POST /auth/login when two factor authentication is enabled", () => {
  it("issues a pending session instead of an active one", async () => {
    const account = await newAccount();

    await database
      .collection<AccountDocument>(ACCOUNTS_COLLECTION)
      .updateOne(
        { _id: account.accountId },
        { $set: { totpSecretCipher: sealSecret("totp-secret", "JBSWY3DPEHPK3PXP") } },
      );

    const response = await login({ accountNumber: account.accountNumber });

    assert.equal(response.status, 200);
    assert.equal(response.body.data?.requiresTwoFactor, true);

    const token = sessionTokenFrom(response.headers);
    assert.ok(token);

    const session = await database
      .collection<SessionDocument>(SESSIONS_COLLECTION)
      .findOne({ tokenHash: hashBearerToken(decodeURIComponent(token)) });

    assert.equal(
      session?.status,
      "pending_totp",
      "a session must not be active until the second factor is verified",
    );
  });
});

describe("POST /auth/login with bad input", () => {
  it("rejects an account number that does not exist", async () => {
    const response = await login({ accountNumber: "0000000000000000" });

    assert.equal(response.status, 401);
    assert.equal(response.body.error?.code, "INVALID_CREDENTIALS");
  });

  it("sets no cookie when the account does not exist", async () => {
    const { headers } = await login({ accountNumber: "0000000000000000" });

    assert.equal(
      headers.getSetCookie().filter((c) => c.startsWith(`${COOKIE_NAME}=`)).length,
      0,
      "a failed login must not hand out a session",
    );
  });

  it("rejects a missing account number", async () => {
    const response = await login({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error?.code, "INVALID_REQUEST");
  });

  it("rejects a number instead of a string", async () => {
    assert.equal((await login({ accountNumber: 1234567890123456 })).status, 400);
  });

  it("rejects a mongodb operator object", async () => {
    const response = await login({ accountNumber: { $ne: null } });

    assert.equal(
      response.status,
      400,
      "an operator object must never reach the query layer",
    );
  });

  it("rejects an account number of the wrong length", async () => {
    for (const value of ["123", "12345678901234567", ""]) {
      assert.equal((await login({ accountNumber: value })).status, 401);
    }
  });

  it("does not reveal whether the account exists", async () => {
    const account = await newAccount();
    const good = await login({ accountNumber: account.accountNumber });
    const bad = await login({ accountNumber: "0000000000000000" });

    assert.notEqual(good.status, bad.status);
    assert.equal(
      bad.body.error?.message,
      (await login({ accountNumber: "1111111111111111" })).body.error?.message,
      "every rejected login must give the identical message",
    );
  });
});
