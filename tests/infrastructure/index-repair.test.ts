import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { ACCOUNTS_COLLECTION } from "../../src/accounts/account.model.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { SESSIONS_COLLECTION } from "../../src/sessions/session.model.js";

let database: Db;

before(async () => {
  database = await connectToMongoDb();
  await ensureIndexes(database);
});

after(async () => {
  await disconnectFromMongoDB();
});

async function indexFor(collectionName: string, field: string) {
  const indexes = await database
    .collection(collectionName)
    .listIndexes()
    .toArray();

  return indexes.find((index) => index.key[field] === 1);
}

async function replaceWithOutdatedIndex(collectionName: string, field: string) {
  const collection = database.collection(collectionName);
  const existing = await indexFor(collectionName, field);

  if (existing) {
    await collection.dropIndex(existing.name);
  }

  await collection.createIndex({ [field]: 1 });
}

describe("ensureIndexes", () => {
  it("runs twice in a row without failing", async () => {
    await ensureIndexes(database);
    await ensureIndexes(database);
  });

  it("repairs a session index that lost its unique option", async () => {
    await replaceWithOutdatedIndex(SESSIONS_COLLECTION, "tokenHash");

    assert.equal(
      (await indexFor(SESSIONS_COLLECTION, "tokenHash"))?.unique,
      undefined,
      "test setup failed: the outdated index should not be unique",
    );

    await ensureIndexes(database);

    assert.equal(
      (await indexFor(SESSIONS_COLLECTION, "tokenHash"))?.unique,
      true,
      "ensureIndexes did not repair the outdated index",
    );
  });

  it("repairs an account index that lost its unique option", async () => {
    await replaceWithOutdatedIndex(ACCOUNTS_COLLECTION, "recoveryPublicKey");

    await ensureIndexes(database);

    assert.equal(
      (await indexFor(ACCOUNTS_COLLECTION, "recoveryPublicKey"))?.unique,
      true,
    );
  });

  it("repairs a ttl index that lost its expiry setting", async () => {
    await replaceWithOutdatedIndex(SESSIONS_COLLECTION, "expiresAt");

    await ensureIndexes(database);

    assert.equal(
      (await indexFor(SESSIONS_COLLECTION, "expiresAt"))?.expireAfterSeconds,
      0,
      "ensureIndexes did not restore the ttl setting",
    );
  });

  it("leaves an index that is already correct in place", async () => {
    const before = await indexFor(SESSIONS_COLLECTION, "accountId");

    await ensureIndexes(database);

    const afterwards = await indexFor(SESSIONS_COLLECTION, "accountId");

    assert.ok(afterwards);
    assert.equal(afterwards.name, before?.name);
  });
});
