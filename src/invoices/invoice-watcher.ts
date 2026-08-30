import { AddressActivity } from "../chains/bitcoin/blockbook.js";
import { Db } from "mongodb";
import { InvoiceDocument, INVOICES_COLLECTION } from "./invoice.model.js";
import { decideInvoiceOutcome } from "./invoice-outcome.js";

export type FetchActivity = (
  address: string,
) => Promise<AddressActivity | undefined>;

export interface WatcherPassResult {
  checked: number;
  updated: number;
}

export async function runWatcherPass(
  database: Db,
  fetchActivity: FetchActivity,
  now: Date = new Date(),
): Promise<WatcherPassResult> {
  const collection = database.collection<InvoiceDocument>(INVOICES_COLLECTION);
  const cutOff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const invoices = await collection
    .find({ status: { $ne: "confirmed" }, expiresAt: { $gt: cutOff } })
    .toArray();

  let checked = 0;
  let updated = 0;

  for (const invoice of invoices) {
    checked++;

    const activity = await fetchActivity(invoice.address);

    if (!activity) {
      continue;
    }

    const outcome = decideInvoiceOutcome(invoice, activity, now);
    const paidSatoshi = activity.confirmedSatoshi + activity.pendingSatoshi;
    if (
      outcome.status === invoice.status &&
      paidSatoshi === invoice.paidSatoshi
    ) {
      continue;
    }

    const setField: Record<string, unknown> = {
      status: outcome.status,
      paidSatoshi,
      updatedAt: now,
    };

    if (
      (outcome.status === "waiting" ||
        outcome.status === "confirming" ||
        outcome.status === "confirmed" ||
        outcome.status === "expired") &&
      invoice.timestamps[outcome.status] === null
    ) {
      setField[`timestamps.${outcome.status}`] = now;
    }

    const result = await collection.updateOne(
      { _id: invoice._id },
      { $set: setField },
    );

    if(result.modifiedCount == 1){
        updated++
    }
  }

  return { checked, updated};
}
