import type { DepositKey, Transfer } from "../chains/adapter.js";
import { User } from "../database/users.model.js";
import { parseFeeRate } from "../money/payout-split.js";

// What every payout from a deposit needs, whoever receives it: the merchant
// payout (invoice.watcher.ts) or a refund route (closed-watch.ts).

export const STUCK_PAYOUT_MS = 24 * 60 * 60 * 1000;

export const DESTINATION_KINDS = new Set<Transfer["kind"]>(["merchant_payout", "refund_route", "swap_deposit"]);

export type StoredTransfer = {
  kind: Transfer["kind"];
  to: string;
  amount: string;
  txid: string;
  status: "pending" | "confirmed" | "failed";
  payout?: number;
};

/** `payout`: the refund route that made them; omitted for the merchant payout. */
export function storeTransfers(
  transfers: Transfer[],
  status: StoredTransfer["status"],
  payout?: number,
): StoredTransfer[] {
  return transfers.map((t) => ({
    kind: t.kind,
    to: t.to,
    amount: t.amount.toString(),
    txid: t.txid,
    status,
    ...(payout === undefined ? {} : { payout }),
  }));
}

export function destinationAmount(transfers: { kind: Transfer["kind"]; amount: bigint }[]): bigint {
  return transfers
    .filter((t) => t.kind === "merchant_payout" || t.kind === "refund_route")
    .reduce((sum, t) => sum + t.amount, 0n);
}

type SealedKeyFields = {
  keyVersion: number;
  initialisationVector: Uint8Array;
  authenticationTag: Uint8Array;
  ciphertext: Uint8Array;
};

export function depositKeyOf(invoice: {
  subaddress_index?: number | null;
  private?: { private_key?: SealedKeyFields | null } | null;
}): DepositKey | undefined {
  if (invoice.subaddress_index != null) return { kind: "subaddress", index: invoice.subaddress_index };
  const stored = invoice.private?.private_key;
  if (!stored) return undefined;
  return {
    kind: "sealed_key",
    sealed: {
      keyVersion: stored.keyVersion,
      initialisationVector: Buffer.from(stored.initialisationVector),
      authenticationTag: Buffer.from(stored.authenticationTag),
      ciphertext: Buffer.from(stored.ciphertext),
    },
  };
}

/** The invoice's fee rate, or the merchant's current one for invoices made before rates were copied. */
export async function feeRateOf(invoice: { fee_rate?: string | null; user_id: string }): Promise<bigint | string> {
  let text = invoice.fee_rate;
  if (!text) {
    const merchant = await User.findOne({ user_id: invoice.user_id }).select("merchant_fee").lean().exec();
    if (!merchant) return `merchant account ${invoice.user_id} was not found, and the invoice has no fee rate of its own`;
    text = merchant.merchant_fee;
  }
  return parseFeeRate(text) ?? `fee rate "${text}" is not a valid rate below 100%`;
}
