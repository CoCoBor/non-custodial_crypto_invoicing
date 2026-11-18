import { z } from "zod";

const MAX_LENGTH = 2048;

// The payer's browser is sent here: only https, so no javascript: or data:
// page can run as the shop, and no credentials in it.
function isAcceptableReturnUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** `return_url` at invoice creation, stored in its normalised form. */
export const returnUrlSchema = z
  .string()
  .max(MAX_LENGTH)
  .refine(isAcceptableReturnUrl)
  .transform((text) => new URL(text).href)
  .refine((href) => href.length <= MAX_LENGTH);

// Spec story 52: back to the shop once the payer is done, whether the
// payment went through or the invoice ended unpaid.
const PAYER_DONE = ["confirmed", "processing", "completed", "failed", "expired", "cancelled"];

/** The URL the payer's page offers now: none until the payer is done. */
export function returnUrlForPayer(invoice: { status?: string | null; return_url?: string | null }): string | null {
  return PAYER_DONE.includes(invoice.status ?? "") && invoice.return_url ? invoice.return_url : null;
}
