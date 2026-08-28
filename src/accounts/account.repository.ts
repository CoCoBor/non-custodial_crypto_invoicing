import { Db, ObjectId } from "mongodb";
import { generateAccountNumber } from "../security/secret-generator.js";
import { generateRecoveryCredential } from "../security/recovery-credential.js";
import { computeBlindIndex } from "../security/blind-index.js";
import { SealedSecret, sealSecret } from "../security/secret-envelope.js";
import { AccountDocument, ACCOUNTS_COLLECTION } from "./account.model.js";
import { hasMongoErrorCode } from "../infrastructure/database/mongo-errors.js";
import { base32Encode } from "../security/totp.js";
import { randomBytes } from "crypto";

export interface CreatedAccount {
  accountId: ObjectId;
  accountNumber: string;
  mnemonic: string;
}

const MAX_ATTEMPTS = 3;

function generatePublicId(): string {
  return `acc_${base32Encode(randomBytes(10))}`;
}


export async function createAccount(database: Db): Promise<CreatedAccount> {
  const collection = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const accountId = new ObjectId();
    const accountNumber = generateAccountNumber();
    const {publicKey, mnemonic} = generateRecoveryCredential();
    const publicId = generatePublicId()
    const date = new Date();

    const document: AccountDocument = {
      _id: accountId,
      publicId,
      accountNumberLookup: computeBlindIndex("account-number", accountNumber),
      accountNumberCipher: sealSecret("account-number", accountNumber),
      recoveryPublicKey: publicKey,
      totpSecretCipher: null,
      totpPendingCipher: null,
      lastUsedTotpStep: null,
      createdAt: date,
      updatedAt: date,
    };

    try {
      await collection.insertOne(document);
      return { accountId, accountNumber, mnemonic: mnemonic };
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

export async function startTotpEnrolment(
  database: Db,
  accountId: ObjectId,
  sealed: SealedSecret,
): Promise<void> {
  const collection = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);

  await collection.updateOne(
    { _id: accountId },
    { $set: { totpPendingCipher: sealed, updatedAt: new Date() } },
  );
}

export async function completeTotpEnrolment(
  database: Db,
  accountId: ObjectId,
): Promise<void> {
  const collection = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);
  const account = await findAccountById(database, accountId);

  if (!account || !account.totpPendingCipher) {
    throw new Error("no pending totp secret to complete");
  }
  const { totpPendingCipher } = account;

  await collection.updateOne(
    { _id: accountId },
    {
      $set: { totpSecretCipher: totpPendingCipher, updatedAt: new Date() },
      $unset: {
        totpPendingCipher: "",
      },
    },
  );
}

export async function consumeTotpStep(
  database: Db,
  accountId: ObjectId,
  step: number,
): Promise<boolean> {
  const collection = database.collection<AccountDocument>(ACCOUNTS_COLLECTION);
  const result = await collection.updateOne(
    {
      _id: accountId,
      $or: [{ lastUsedTotpStep: null }, { lastUsedTotpStep: { $lt: step } }],
    },
    { $set: { lastUsedTotpStep: step, updatedAt: new Date() } },
  );

  return result.modifiedCount === 1;
}
