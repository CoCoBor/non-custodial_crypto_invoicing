import { Invoice } from "../database/invoices.model.js";

export async function findInvoiceById(invoiceId: string, userId: string) {
  return await Invoice.findOne({
    invoice_id: invoiceId,
    user_id: userId,
  })
    .select("-private")
    .lean()
    .exec();
}

export function getPaymentStatus(input: {
  requiredAmount: bigint;
  receivedAmount: bigint;
  confirmedAmount: bigint;
}): "waiting" | "underpaid" | "confirming" | "confirmed" {
  const { requiredAmount, receivedAmount, confirmedAmount } = input;
  if (confirmedAmount >= requiredAmount) return "confirmed";
  if (receivedAmount >= requiredAmount) return "confirming";
  if (receivedAmount > 0n) return "underpaid";
  return "waiting";
}
