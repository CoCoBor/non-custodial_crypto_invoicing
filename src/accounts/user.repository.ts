import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { User } from "./user.model.js";
import { generateAccountNumber } from "../security/secret-generator.js";
import { computeBlindIndex } from "../security/blind-index.js";
import { hasMongoErrorCode } from "../infrastructure/database/mongo-errors.js";
import { generateRecoveryCredential } from "../security/recovery-credential.js";
import { sealSecret } from "../security/secret-envelope.js";

export interface CreatedMerchantAccount {
  userId: string;
  accountNumber: string;
  recoveryPhrase: string;
}

export async function createMerchantAccount(): Promise<CreatedMerchantAccount> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const accountNumber = generateAccountNumber();
    const userId = randomUUID();
    const { mnemonic, publicKey } = generateRecoveryCredential();
    try {
      await User.create({
        user_id: userId,
        account_hash: computeBlindIndex("account-number", accountNumber),
        account_number_cipher: sealSecret("account-number", accountNumber),
        recovery_public_key: publicKey,
        member_since: Date.now(),
        merchant_key: randomUUID()
      });
      return { userId, accountNumber, recoveryPhrase: mnemonic };
    } catch (error) {
      if (hasMongoErrorCode(error, 11000)) continue;
      // Mongoose errors may include the document or credential values.
      throw new Error("Merchant account could not be created");
    }
  }
  throw new Error(
    "Merchant account could not be allocated after three attempts",
  );
}

export function findUserByNumber(accountNumber: string) {
  return User.findOne({
    account_hash: computeBlindIndex("account-number", accountNumber),
  }).exec();
}

export function findUserById(accountId: ObjectId) {
  return User.findById(accountId).exec();
}
