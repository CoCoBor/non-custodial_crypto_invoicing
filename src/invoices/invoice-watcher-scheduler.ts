import type { Db } from "mongodb";
import { runWatcherPass } from "./invoice-watcher.js";
import { fetchAddressActivity } from "../chains/bitcoin/blockbook.js";
import { InvoiceDocument, INVOICES_COLLECTION } from "./invoice.model.js";

const POLL_INTERVAL_MS = 30_000;

export function startInvoiceWatcher(database: Db): () => void {
  let running = false;

  const interval = setInterval(() => {
    if (running) {
      return;
    }
    running = true;

    runWatcherPass(database, fetchAddressActivity)
      .catch((error) => console.error(error))
      .finally(() => {
        running = false;
      });
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}

export async function findInvoiceByPublicId(
  database: Db,
  invoiceId: string,
): Promise<InvoiceDocument | null> {
  const collection = database.collection<InvoiceDocument>(INVOICES_COLLECTION);
  return collection.findOne({ publicId: invoiceId });
}