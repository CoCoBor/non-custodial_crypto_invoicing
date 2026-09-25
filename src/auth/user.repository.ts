import { randomInt, randomUUID } from "node:crypto";
import { generateRecoveryCredential } from "../security/recovery-credential.js";
import { computeBlindIndex } from "../security/blind-index.js";
import { sealSecret } from "../security/secret-envelope.js";
import { hasMongoErrorCode } from "../infrastructure/database/mongo-errors.js";
import { User } from "../database/users.model.js";

function generateAccountNumber() {
  let num = "";
  for (let attempt = 0; attempt < 16; attempt++) {
    num += randomInt(0, 10);
  }
  return num;
}

export interface CreateMerchantAccount {
  userId: string;
  accountNumber: string;
  recoveryPhrase: string;
}

export async function createMerchantAccount(): Promise<CreateMerchantAccount> {
  for (let i = 0; i < 3; i++) {
    const accountNunmber = generateAccountNumber();

    const userId = randomUUID();

    const { mnemonic, publicKey } = generateRecoveryCredential();

    try {
      await User.create({
        user_id: userId,
        account_hash: computeBlindIndex("account-number", accountNunmber),
        account_number_cipher: sealSecret("account-number", accountNunmber),
        recovery_public_key: publicKey,
        member_since: Date.now(),
        merchant_key: randomUUID(),
      });

      return {
        userId,
        accountNumber: accountNunmber,
        recoveryPhrase: mnemonic,
      };
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
