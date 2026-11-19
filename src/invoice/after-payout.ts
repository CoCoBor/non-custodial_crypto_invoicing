import { isAssetId } from "../assets/payout-address.js";
import type { AfterPayoutRequest, ChainRegistry } from "../chains/adapter.js";
import { Invoice } from "../database/invoices.model.js";
import { depositKeyOf, storeTransfers } from "./deposit-payout.js";

// Work an adapter does after a payout is proven, which must not hold it up
// (owner decision 2026-11-20: a Tron invoice is completed as soon as the
// USDT transfers are final; the deposit's unused TRX goes back to the gas
// wallet afterwards). The watcher marks it pending in the same update that
// records `paid`, on the invoice (payout 0) or on the refund route. The
// status never changes here.

/** Assets whose adapter has work after a payout. */
export function assetsWithAfterPayout(chains: ChainRegistry): string[] {
  return Object.values(chains)
    .filter((adapter) => adapter?.afterPayout !== undefined)
    .map((adapter) => adapter!.asset);
}

export async function invoicesAfterPayout(assets: string[]) {
  if (assets.length === 0) return [];
  return await Invoice.find({
    crypto: { $in: assets },
    $or: [{ after_payout_pending: true }, { "refund_routes.after_payout_pending": true }],
  })
    .select("invoice_id crypto -_id")
    .lean()
    .exec();
}

/**
 * Asks the adapter once for each pending piece of work on this invoice. Each
 * save is a compare-and-set on the state the run read last; a transfer is
 * recorded, and the work closed, by one update with the same condition.
 */
export async function runAfterPayouts(invoiceId: string, chains: ChainRegistry): Promise<void> {
  const invoice = await Invoice.findOne({ invoice_id: invoiceId })
    .select("+private.private_key +tx.raw +refund_routes.raw")
    .exec();
  if (!invoice) return;
  const adapter = isAssetId(invoice.crypto) ? chains[invoice.crypto] : undefined;
  const depositKey = depositKeyOf(invoice);
  if (adapter?.afterPayout === undefined || depositKey === undefined) return;

  const pieces: { payout?: number; state: string; field: string; done: string }[] = [];
  if (invoice.after_payout_pending) {
    pieces.push({ state: invoice.tx?.raw ?? "", field: "tx.raw", done: "after_payout_pending" });
  }
  for (const route of invoice.refund_routes ?? []) {
    if (!route.after_payout_pending) continue;
    pieces.push({
      payout: route.n,
      state: route.raw ?? "",
      field: "refund_routes.$.raw",
      done: "refund_routes.$.after_payout_pending",
    });
  }

  for (const piece of pieces) {
    let current = piece.state;
    const unchanged = () =>
      piece.payout === undefined
        ? { invoice_id: invoiceId, after_payout_pending: true, "tx.raw": current }
        : { invoice_id: invoiceId, refund_routes: { $elemMatch: { n: piece.payout, after_payout_pending: true, raw: current } } };
    const request: AfterPayoutRequest = {
      depositAddress: invoice.address,
      depositKey,
      state: current,
      saveState: async (next) => {
        const result = await Invoice.updateOne(unchanged(), { $set: { [piece.field]: next } }).exec();
        if (result.matchedCount !== 1) {
          console.warn("Another run saved this work after a payout first:", invoiceId, piece.payout ?? 0);
          return false;
        }
        current = next;
        return true;
      },
    };

    const result = await adapter.afterPayout(request);
    if (result.status === "pending") {
      console.warn(`Work after payout ${piece.payout ?? 0} pending (${result.reason}):`, invoiceId);
      continue;
    }
    // watch_version: the closed-invoice watch rewrites `transfers` from its
    // own copy, guarded by it.
    await Invoice.updateOne(unchanged(), {
      $set: { [piece.done]: false },
      $push: { transfers: { $each: storeTransfers(result.transfers, "confirmed", piece.payout) } },
      $inc: { watch_version: 1 },
    }).exec();
  }
}
