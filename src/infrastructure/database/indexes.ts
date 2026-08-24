import { Db } from "mongodb";
import { ACCOUNTS_COLLECTION } from "../../accounts/account.model.js";

export async function ensureIndexes(database: Db): Promise<void> {
  const collection = database.collection(ACCOUNTS_COLLECTION);

  await Promise.all([
    collection.createIndex({ accountNumberLookup: 1 }, { unique: true }),
    collection.createIndex({ recoveryPublicKey: 1 }, { unique: true }),
  ]);
}
