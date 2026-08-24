import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Db, MongoServerError } from "mongodb";

import {
  ACCOUNTS_COLLECTION,
  type AccountDocument,
} from "../../src/accounts/account.model.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { sealSecret } from "../../src/security/secret-envelope.js";

let database: Db;
const insertedLookups: string[] = [];

function buildAccount(lookup: string): Omit<AccountDocument, "_id"> {
  return {
    accountNumberLookup: lookup,
    accountNumberCipher: sealSecret("account-number", "1234567890123456"),
    recoveryPublicKey: `recovery-${lookup}`,
    totpSecretCipher: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

before(async () => {
  database = await connectToMongoDb();
  await ensureIndexes(database);
});

after(async () => {
  if (insertedLookups.length > 0) {
    await database
      .collection(ACCOUNTS_COLLECTION)
      .deleteMany({ accountNumberLookup: { $in: insertedLookups } });
  }

  await disconnectFromMongoDB();
});

describe("ensureIndexes", () => {
  it("creates a unique index on the account number lookup", async () => {
    const indexes = await database
      .collection(ACCOUNTS_COLLECTION)
      .listIndexes()
      .toArray();

    const lookupIndex = indexes.find(
      (index) => index.key.accountNumberLookup === 1,
    );

    assert.ok(lookupIndex, "no index on accountNumberLookup");
    assert.equal(lookupIndex.unique, true, "the index is not unique");
  });

  it("creates a unique index on the recovery public key", async () => {
    const indexes = await database
      .collection(ACCOUNTS_COLLECTION)
      .listIndexes()
      .toArray();

    const recoveryIndex = indexes.find(
      (index) => index.key.recoveryPublicKey === 1,
    );

    assert.ok(recoveryIndex, "no index on recoveryPublicKey");
    assert.equal(recoveryIndex.unique, true, "the index is not unique");
  });

  it("can be run again without failing", async () => {
    await ensureIndexes(database);
    await ensureIndexes(database);
  });
});

describe("the unique index", () => {
  it("rejects a second account with the same account number lookup", async () => {
    const lookup = `test-lookup-${Date.now()}`;
    insertedLookups.push(lookup);

    const accounts = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);

    await accounts.insertOne(buildAccount(lookup) as AccountDocument);

    await assert.rejects(
      () => accounts.insertOne(buildAccount(lookup) as AccountDocument),
      (error: MongoServerError) => {
        assert.equal(error.code, 11000, "expected a duplicate key error");
        return true;
      },
      "the database accepted a duplicate account number",
    );
  });

  it("rejects a second account with the same recovery public key", async () => {
    const first = `test-lookup-a-${Date.now()}`;
    const second = `test-lookup-b-${Date.now()}`;
    insertedLookups.push(first, second);

    const accounts = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);

    const account = buildAccount(first);
    await accounts.insertOne(account as AccountDocument);

    await assert.rejects(
      () =>
        accounts.insertOne({
          ...buildAccount(second),
          recoveryPublicKey: account.recoveryPublicKey,
        } as AccountDocument),
      (error: MongoServerError) => {
        assert.equal(error.code, 11000, "expected a duplicate key error");
        return true;
      },
      "the database accepted a duplicate recovery public key",
    );
  });
});
