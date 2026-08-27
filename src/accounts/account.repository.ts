import { Db, ObjectId } from "mongodb";
import { generateAccountNumber } from "../security/secret-generator.js";
import { generateRecoveryCredential } from "../security/recovery-credential.js";
import { computeBlindIndex } from "../security/blind-index.js";
import { sealSecret } from "../security/secret-envelope.js";
import { AccountDocument, ACCOUNTS_COLLECTION } from "./account.model.js";
import { hasMongoErrorCode } from "../infrastructure/database/mongo-errors.js";

export interface CreatedAccount {
  accountId: ObjectId;
  accountNumber: string;
  mnemonic: string;
}

const MAX_ATTEMPTS = 3;

export async function createAccount(database: Db): Promise<CreatedAccount> {
  const collection = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const accountId = new ObjectId();
    const accountNumber = generateAccountNumber();
    const recovery = generateRecoveryCredential();
    const date = new Date();

    const document: AccountDocument = {
      _id: accountId,
      accountNumberLookup: computeBlindIndex("account-number", accountNumber),
      accountNumberCipher: sealSecret("account-number", accountNumber),
      recoveryPublicKey: recovery.publicKey,
      totpSecretCipher: null,
      createdAt: date,
      updatedAt: date,
    };

    try {
      await collection.insertOne(document);
      return { accountId, accountNumber, mnemonic: recovery.mnemonic };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }
  throw new Error(
    "failed to create account after multiple attempts due to account number collisions",
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return hasMongoErrorCode(error, 11000);
}

export async function findAccountByNumber(
  database: Db,
  accountNumber: string,
): Promise<AccountDocument | null> {
  const collection = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);
  const accountNumberLookup = computeBlindIndex(
    "account-number",
    accountNumber,
  );
  const data = await collection.findOne({ accountNumberLookup });

  if (!data) {
    return null;
  }

  return data;
}

export async function findAccountById(
  database: Db,
  accountId: ObjectId,
): Promise<AccountDocument | null> {
  const collection = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);

  const data = collection.findOne({ _id: accountId });

  if (!data) {
    return null;
  }

  return data;
}