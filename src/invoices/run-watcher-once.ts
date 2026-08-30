import { fetchAddressActivity } from "../chains/bitcoin/blockbook.js";
import { ensureIndexes } from "../infrastructure/database/indexes.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../infrastructure/database/mongodb.js";
import { runWatcherPass } from "./invoice-watcher.js";

async function main() {
  const db = await connectToMongoDb();
  await ensureIndexes(db);

  const result = await runWatcherPass(db, fetchAddressActivity);
  console.log(result);

  await disconnectFromMongoDB();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1
});
