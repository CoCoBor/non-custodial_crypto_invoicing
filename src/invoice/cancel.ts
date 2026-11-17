import type { ChainRegistry } from "../chains/adapter.js";
import { adapterFor } from "../chains/registry.js";
import { cancelUnpaidInvoice } from "./invoice.repository.js";

export type CancelResult = "cancelled" | "payment_seen" | "chain_unavailable";

/**
 * Cancels an invoice while no payment has been seen, for the merchant or the
 * payer. The chain is asked now: the stored paid_amount can be a pass (15 s)
 * old. A failed lookup refuses the cancel rather than cancel blind. Money
 * that lands after this check is caught by the 7-day watch and routed.
 */
export async function cancelIfUnpaid(
  invoice: { invoice_id: string; status?: string | null; paid_amount?: string | null; crypto?: string | null; address?: string | null },
  chains: ChainRegistry,
  now: number,
): Promise<CancelResult> {
  if (invoice.status !== "waiting" || (invoice.paid_amount ?? "0") !== "0") return "payment_seen";

  const address = invoice.address ?? "";
  if (address) {
    const adapter = adapterFor(invoice.crypto ?? "", chains);
    if (adapter === undefined) return "chain_unavailable";
    const payments = await adapter.getPayments(address);
    if (payments === undefined) return "chain_unavailable";
    if (payments.some((p) => p.amount > 0n)) return "payment_seen";
  }

  return (await cancelUnpaidInvoice(invoice.invoice_id, address, now)) ? "cancelled" : "payment_seen";
}
