import {
  Collection,
  Db,
  CreateIndexesOptions,
  IndexSpecification,
} from "mongodb";
import { ACCOUNTS_COLLECTION } from "../../accounts/account.model.js";
import { SESSIONS_COLLECTION } from "../../sessions/session.model.js";
import { hasMongoErrorCode } from "./mongo-errors.js";
import { env } from "../../config/env.js";

async function ensureIndex(
  collection: Collection,
  keys: IndexSpecification,
  options: CreateIndexesOptions,
) {
  try {
    await collection.createIndex(keys, options);
  } catch (error) {
    if (!hasMongoErrorCode(error, 85, 86)) throw error;
    if (env.nodeEnvironment === "production")
      throw new Error(
    `Index conflict on "${collection.collectionName}" for keys ${JSON.stringify(keys)}. ` +
    `An existing index with different options was found (expected ${JSON.stringify(options)}). ` +
    `Refusing to auto-fix in production — run a manual migration.`,
  );
  
  const existingIndexes = await collection.listIndexes().toArray();
  const conflicting = existingIndexes.find(
    (index) => JSON.stringify(index.key) === JSON.stringify(keys),
  );
  
  if (!conflicting || !conflicting.name) {
    throw error;
  }
  
  await collection.dropIndex(conflicting.name);
  await collection.createIndex(keys, options);
}
}

export async function ensureIndexes(database: Db): Promise<void> {
  const accounts = database.collection(ACCOUNTS_COLLECTION);
  const sessions = database.collection(SESSIONS_COLLECTION);
  await Promise.all([
    ensureIndex(accounts, { accountNumberLookup: 1 }, { unique: true }),
    ensureIndex(accounts, { recoveryPublicKey: 1 }, { unique: true }),
    ensureIndex(sessions, { expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ensureIndex(sessions, { tokenHash: 1 }, { unique: true }),
    ensureIndex(sessions, { accountId: 1 }, {}),
  ]);
}