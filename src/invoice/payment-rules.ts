export const MAX_UNDERPAID_PERCENT = 5;

/**
 * The merchant's underpaid tolerance (a percentage, at most 2 decimals, from
 * 0 to 5) as basis points, or undefined if it is not one.
 */
export function toleranceBasisPoints(percent: number): bigint | undefined {
  if (!Number.isFinite(percent) || percent < 0 || percent > MAX_UNDERPAID_PERCENT) {
    return undefined;
  }
  const basisPoints = Math.round(percent * 100);
  if (Math.abs(basisPoints - percent * 100) > 1e-9) return undefined;
  return BigInt(basisPoints);
}

/** The least a payer may send: the amount less the tolerance, rounded up. */
export function minimumAcceptedAmount(amount: bigint, toleranceBps: bigint): bigint {
  return amount - (amount * toleranceBps) / 10_000n;
}
