import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db, ObjectId } from "mongodb";

import { ACCOUNTS_COLLECTION } from "../../src/accounts/account.model.js";
import { createAccount } from "../../src/accounts/account.repository.js";
import { createApp } from "../../src/app.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { hashBearerToken } from "../../src/security/secret-generator.js";
import {
  SESSIONS_COLLECTION,
  type SessionDocument,
} from "../../src/sessions/session.model.js";
import { createSession } from "../../src/sessions/session.repository.js";

const COOKIE_NAME = "session";

let database: Db;
let server: Server;
let baseUrl: string;

const createdAccountIds: ObjectId[] = [];

async function newAccountId(): Promise<ObjectId> {
  const account = await createAccount(database);
  createdAccountIds.push(account.accountId);

  return account.accountId;
}

async function newToken(status: "active" | "pending_totp" = "active") {
  const accountId = await newAccountId();
  const { token, sessionId } = await createSession(database, {
    accountId,
    status,
    ipAddress: null,
    userAgent: null,
  });

  return { token, sessionId, accountId };
}

function sessions() {
  return database.collection<SessionDocument>(SESSIONS_COLLECTION);
}

async function get(path: string, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { cookie: `${COOKIE_NAME}=${token}` } : {},
  });

  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as {
      data?: Record<string, unknown>;
      error?: { code: string; message: string };
    },
  };
}

async function logout(token?: string) {
  const response = await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
    headers: token ? { cookie: `${COOKIE_NAME}=${token}` } : {},
  });

  return { status: response.status, headers: response.headers };
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
    await sessions().deleteMany({ accountId: { $in: createdAccountIds } });
    await database
      .collection(ACCOUNTS_COLLECTION)
      .deleteMany({ _id: { $in: createdAccountIds } });
  }

  server.close();
  await once(server, "close");
  await disconnectFromMongoDB();
});

describe("GET /auth/session without a usable session", () => {
  it("rejects a request with no cookie at all", async () => {
    const response = await get("/auth/session");

    assert.equal(response.status, 401);
    assert.equal(response.body.error?.code, "UNAUTHENTICATED");
  });

  it("rejects a token that was never issued", async () => {
    assert.equal((await get("/auth/session", "not-a-real-token")).status, 401);
  });

  it("rejects a session that is still awaiting its second factor", async () => {
    const { token } = await newToken("pending_totp");

    assert.equal(
      (await get("/auth/session", token)).status,
      401,
      "a pending_totp session must not reach a protected route",
    );
  });

  it("rejects a session whose idle expiry has passed", async () => {
    const { token, sessionId } = await newToken();

    await sessions().updateOne(
      { _id: sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    assert.equal((await get("/auth/session", token)).status, 401);
  });

  it("rejects a session whose absolute expiry has passed", async () => {
    const { token, sessionId } = await newToken();

    await sessions().updateOne(
      { _id: sessionId },
      { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } },
    );

    assert.equal((await get("/auth/session", token)).status, 401);
  });
});

describe("GET /auth/session with an active session", () => {
  it("responds 200", async () => {
    const { token } = await newToken();

    assert.equal((await get("/auth/session", token)).status, 200);
  });

  it("reports whether two factor authentication is enabled", async () => {
    const { token } = await newToken();
    const { body } = await get("/auth/session", token);

    assert.equal(body.data?.twoFactorEnabled, false);
  });

  it("reports when the account was created and when the session lapses", async () => {
    const { token } = await newToken();
    const { body } = await get("/auth/session", token);

    assert.ok(body.data?.memberSince, "memberSince missing");
    assert.ok(body.data?.sessionExpiresAt, "sessionExpiresAt missing");
    assert.ok(
      !Number.isNaN(Date.parse(String(body.data.memberSince))),
      "memberSince is not a date",
    );
  });

  it("never exposes the account number, its hash, or internal ids", async () => {
    const { token } = await newToken();
    const { body } = await get("/auth/session", token);

    const serialised = JSON.stringify(body);
    for (const leak of ["accountNumberLookup", "accountNumberCipher", "tokenHash", "_id"]) {
      assert.ok(!serialised.includes(leak), `response leaked ${leak}`);
    }
  });

  it("tells caches never to store the response", async () => {
    const { token } = await newToken();
    const { headers } = await get("/auth/session", token);

    assert.match(headers.get("cache-control") ?? "", /no-store/);
  });

  it("pushes the idle expiry further out on every request", async () => {
    const { token, sessionId } = await newToken();

    const earlier = new Date(Date.now() + 60 * 1000);
    await sessions().updateOne({ _id: sessionId }, { $set: { expiresAt: earlier } });

    await get("/auth/session", token);

    const refreshed = await sessions().findOne({ _id: sessionId });
    assert.ok(
      refreshed && refreshed.expiresAt > earlier,
      "the idle window must slide forward while the session is in use",
    );
  });

  it("does not push the absolute expiry", async () => {
    const { token, sessionId } = await newToken();

    const before = await sessions().findOne({ _id: sessionId });
    await get("/auth/session", token);
    const afterwards = await sessions().findOne({ _id: sessionId });

    assert.equal(
      afterwards?.absoluteExpiresAt.getTime(),
      before?.absoluteExpiresAt.getTime(),
      "the absolute lifetime must never be extended",
    );
  });
});

describe("POST /auth/logout", () => {
  it("deletes the session row rather than only clearing the cookie", async () => {
    const { token, sessionId } = await newToken();

    await logout(token);

    assert.equal(
      await sessions().findOne({ _id: sessionId }),
      null,
      "the session must be gone from the database",
    );
  });

  it("makes the token unusable afterwards", async () => {
    const { token } = await newToken();

    assert.equal((await get("/auth/session", token)).status, 200);
    await logout(token);
    assert.equal((await get("/auth/session", token)).status, 401);
  });

  it("clears the cookie in the browser too", async () => {
    const { token } = await newToken();
    const { headers } = await logout(token);

    const cookie = headers
      .getSetCookie()
      .find((value) => value.startsWith(`${COOKIE_NAME}=`));

    assert.ok(cookie, "logout should clear the cookie");
    assert.match(cookie, /(Expires=Thu, 01 Jan 1970|Max-Age=0)/i);
  });

  it("succeeds even with no session, so a double logout is harmless", async () => {
    assert.equal((await logout()).status, 200);
    assert.equal((await logout("not-a-real-token")).status, 200);
  });

  it("leaves other sessions of the same account alone", async () => {
    const accountId = await newAccountId();

    const first = await createSession(database, {
      accountId,
      status: "active",
      ipAddress: null,
      userAgent: null,
    });
    const second = await createSession(database, {
      accountId,
      status: "active",
      ipAddress: null,
      userAgent: null,
    });

    await logout(first.token);

    assert.equal(await sessions().findOne({ _id: first.sessionId }), null);
    assert.ok(
      await sessions().findOne({ _id: second.sessionId }),
      "logging out one device must not sign out the others",
    );
  });
});

describe("the session cookie", () => {
  it("is url decoded before it is hashed", async () => {
    const { token } = await newToken();

    const stored = await sessions().findOne({ tokenHash: hashBearerToken(token) });
    assert.ok(stored, "test setup issue: token does not match its stored hash");

    assert.equal((await get("/auth/session", encodeURIComponent(token))).status, 200);
  });
});
