import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Db, ObjectId } from "mongodb";

import {
  ACCOUNTS_COLLECTION,
  type AccountDocument,
} from "../../src/accounts/account.model.js";
import { createAccount } from "../../src/accounts/account.repository.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";
import { derivePublicKeyFromMnemonic } from "../../src/security/recovery-credential.js";
import { openSecret } from "../../src/security/secret-envelope.js";

let database: Db;
const createdIds: ObjectId[] = [];

async function create() {
  const account = await createAccount(database);
  createdIds.push(account.accountId);

  return account;
}

function storedDocument(accountId: ObjectId) {
  return database
    .collection<AccountDocument>(ACCOUNTS_COLLECTION)
    .findOne({ _id: accountId });
}

before(async () => {
  database = await connectToMongoDb();
  await ensureIndexes(database);
});

after(async () => {
  if (createdIds.length > 0) {
    await database
      .collection(ACCOUNTS_COLLECTION)
      .deleteMany({ _id: { $in: createdIds } });
  }

  await disconnectFromMongoDB();
});

describe("createAccount", () => {
  it("returns a 16 digit account number", async () => {
    assert.match((await create()).accountNumber, /^[0-9]{16}$/);
  });

  it("returns a 12 word recovery mnemonic", async () => {
    assert.equal((await create()).mnemonic.split(" ").length, 12);
  });

  it("creates a different account every time", async () => {
    const first = await create();
    const second = await create();

    assert.notEqual(first.accountNumber, second.accountNumber);
    assert.notEqual(first.mnemonic, second.mnemonic);
    assert.notEqual(String(first.accountId), String(second.accountId));
  });

  it("stores a document that can be found by blind index", async () => {
    const account = await create();

    const found = await database
      .collection<AccountDocument>(ACCOUNTS_COLLECTION)
      .findOne({
        accountNumberLookup: computeBlindIndex(
          "account-number",
          account.accountNumber,
        ),
      });

    assert.ok(found, "the account could not be found by its blind index");
    assert.equal(String(found._id), String(account.accountId));
  });

  it("stores the account number encrypted, recoverable only with the key", async () => {
    const account = await create();
    const document = await storedDocument(account.accountId);

    assert.ok(document);
    assert.equal(
      openSecret("account-number", document.accountNumberCipher),
      account.accountNumber,
    );
  });

  it("never writes the plaintext account number or mnemonic to the database", async () => {
    const account = await create();
    const document = await storedDocument(account.accountId);

    assert.ok(document);

    const serialised = JSON.stringify(document);
    assert.ok(
      !serialised.includes(account.accountNumber),
      "the plaintext account number was stored",
    );

    for (const word of account.mnemonic.split(" ")) {
      assert.ok(
        !serialised.includes(` ${word} `),
        `the mnemonic word "${word}" was stored`,
      );
    }
  });

  it("stores the recovery public key derived from the mnemonic", async () => {
    const account = await create();
    const document = await storedDocument(account.accountId);

    assert.ok(document);
    assert.equal(
      document.recoveryPublicKey,
      derivePublicKeyFromMnemonic(account.mnemonic),
    );
  });

  it("starts with two factor authentication disabled", async () => {
    const document = await storedDocument((await create()).accountId);

    assert.ok(document);
    assert.equal(document.totpSecretCipher, null);
  });

  it("records when the account was created", async () => {
    const before = new Date();
    const document = await storedDocument((await create()).accountId);

    assert.ok(document);
    assert.ok(document.createdAt instanceof Date);
    assert.ok(document.updatedAt instanceof Date);
    assert.ok(document.createdAt.getTime() >= before.getTime() - 1000);
  });
});
