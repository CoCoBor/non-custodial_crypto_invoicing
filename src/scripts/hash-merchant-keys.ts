// One-off: API keys used to be stored in plain text in users.merchant_key.
// This stores each one as its keyed hash (so the key keeps working) and
// removes the plain copy. Run once against the real database:
//   npx tsx src/scripts/hash-merchant-keys.ts
import { pathToFileURL } from "node:url";

import type { Db } from "mongodb";

import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../infrastructure/database/mongodb.js";
import { computeBlindIndex } from "../security/blind-index.js";

export async function hashPlainMerchantKeys(db: Db): Promise<number> {
  const users = db.collection("users");
  const withPlainKey = users.find(
    { merchant_key: { $type: "string", $gt: "" } },
    { projection: { _id: 1, merchant_key: 1, api_key_hash: 1 } },
  );

  let converted = 0;
  for await (const user of withPlainKey) {
    // A merchant who already made a new key has stopped using the old one.
    const changes = user.api_key_hash
      ? { $unset: { merchant_key: "" } }
      : {
          $set: { api_key_hash: computeBlindIndex("api-key", user.merchant_key) },
          $unset: { merchant_key: "" },
        };
    const result = await users.updateOne(
      { _id: user._id, merchant_key: user.merchant_key },
      changes,
    );
    if (!user.api_key_hash) converted += result.modifiedCount;
  }
  return converted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await connectToMongoDb();
  try {
    const converted = await hashPlainMerchantKeys(db);
    console.log(`Stored ${converted} plain API key(s) as keyed hashes.`);
  } finally {
    await disconnectFromMongoDB();
  }
}
