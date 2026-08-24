import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type Db, ObjectId } from "mongodb";

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
import {
  createSession,
  findValidSession,
} from "../../src/sessions/session.repository.js";

let database: Db;
const accountId = new ObjectId();

before(async () => {
  database = await connectToMongoDb();
  await ensureIndexes(database);
});

after(async () => {
  await database.collection(SESSIONS_COLLECTION).deleteMany({ accountId });
  await disconnectFromMongoDB();
});

function sessions() {
  return database.collection<SessionDocument>(SESSIONS_COLLECTION);
}

describe("createSession", () => {
  it("returns a token that is safe for a cookie", async () => {
    const { token } = await createSession(database, {
      accountId,
      status: "active",
      ipAddress: "127.0.0.1",
      userAgent: "node-test",
    });

    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(token.length, 43);
  });

  it("never stores the token itself, only its hash", async () => {
    const { token, sessionId } = await createSession(database, {
      accountId,
      status: "active",
      ipAddress: null,
      userAgent: null,
    });

    const document = await sessions().findOne({ _id: sessionId });

    assert.ok(document);
    assert.ok(
      !JSON.stringify(document).includes(token),
      "the raw session token was written to the database",
    );
    assert.equal(document.tokenHash, hashBearerToken(token));
  });

  it("issues a different token every time", async () => {
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

    assert.notEqual(first.token, second.token);
  });

  it("sets an idle expiry and a longer absolute expiry", async () => {
    const { sessionId } = await createSession(database, {
      accountId,
      status: "active",
      ipAddress: null,
      userAgent: null,
    });

    const document = await sessions().findOne({ _id: sessionId });

    assert.ok(document);
    assert.ok(document.expiresAt > new Date(), "idle expiry is not in the future");
    assert.ok(
      document.absoluteExpiresAt > document.expiresAt,
      "the absolute expiry must be later than the idle expiry",
    );
  });

  it("records the status it was created with", async () => {
    const { sessionId } = await createSession(database, {
      accountId,
      status: "pending_totp",
      ipAddress: null,
      userAgent: null,
    });

    const document = await sessions().findOne({ _id: sessionId });

    assert.equal(document?.status, "pending_totp");
  });
});

describe("findValidSession", () => {
  it("finds a session by its token", async () => {
    const { token, sessionId } = await createSession(database, {
      accountId,
      status: "active",
      ipAddress: null,
      userAgent: null,
    });

    const found = await findValidSession(database, token);

    assert.ok(found);
    assert.equal(String(found._id), String(sessionId));
    assert.equal(String(found.accountId), String(accountId));
  });

  it("returns a pending session too, so the caller can decide", async () => {
    const { token } = await createSession(database, {
      accountId,
      status: "pending_totp",
      ipAddress: null,
      userAgent: null,
    });

    assert.equal((await findValidSession(database, token))?.status, "pending_totp");
  });

  it("returns null for a token that was never issued", async () => {
    assert.equal(await findValidSession(database, "not-a-real-token"), null);
  });

  it("returns null for an expired session even before the ttl removes it", async () => {
    const { token, sessionId } = await createSession(database, {
      accountId,
      status: "active",
      ipAddress: null,
      userAgent: null,
    });

    await sessions().updateOne(
      { _id: sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    assert.equal(
      await findValidSession(database, token),
      null,
      "an expired session must not be usable while the ttl job has not run yet",
    );
  });

  it("returns null once the absolute expiry has passed", async () => {
    const { token, sessionId } = await createSession(database, {
      accountId,
      status: "active",
      ipAddress: null,
      userAgent: null,
    });

    await sessions().updateOne(
      { _id: sessionId },
      { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } },
    );

    assert.equal(await findValidSession(database, token), null);
  });
});

describe("session indexes", () => {
  it("makes the token hash unique", async () => {
    const indexes = await sessions().listIndexes().toArray();
    const tokenIndex = indexes.find((index) => index.key.tokenHash === 1);

    assert.ok(tokenIndex, "no index on tokenHash");
    assert.equal(tokenIndex.unique, true);
  });

  it("indexes accountId so every session of an account can be revoked", async () => {
    const indexes = await sessions().listIndexes().toArray();

    assert.ok(
      indexes.some((index) => index.key.accountId === 1),
      "no index on accountId",
    );
  });

  it("lets mongodb delete expired sessions on its own", async () => {
    const indexes = await sessions().listIndexes().toArray();
    const ttlIndex = indexes.find((index) => index.key.expiresAt === 1);

    assert.ok(ttlIndex, "no index on expiresAt");
    assert.equal(
      ttlIndex.expireAfterSeconds,
      0,
      "expiresAt must be a ttl index so old sessions are cleaned up",
    );
  });
});
