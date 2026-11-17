import { percentToBasisPoints } from "../money/percent.js";

export const MAX_UNDERPAID_PERCENT = 5;

/**
 * The merchant's underpaid tolerance (a percentage, at most 2 decimals, from
 * 0 to 5) as basis points, or undefined if it is not one.
 */
export function toleranceBasisPoints(percent: number): bigint | undefined {
  return percentToBasisPoints(percent, 0, MAX_UNDERPAID_PERCENT);
}

/** The least a payer may send: the amount less the tolerance, rounded up. */
export function minimumAcceptedAmount(amount: bigint, toleranceBps: bigint): bigint {
  return amount - (amount * toleranceBps) / 10_000n;
}

/**
 * What the payer is asked to send: more than `amount` in payer-pays mode.
 * Invoices made before asked_amount was stored asked for `amount`.
 */
export function askedAmount(invoice: {
  amount: string;
  asked_amount?: string | null;
}): bigint {
  return BigInt(invoice.asked_amount || invoice.amount);
}

/**
 * The least that pays this invoice: the asked amount less the tolerance.
 * The watcher confirms at this amount and the payout releases at it, so they
 * can never disagree.
 */
export function acceptedPaymentAmount(invoice: {
  amount: string;
  asked_amount?: string | null;
  underpaid?: number | null;
}): bigint {
  return minimumAcceptedAmount(
    askedAmount(invoice),
    toleranceBasisPoints(invoice.underpaid ?? 0) ?? 0n,
  );
}
