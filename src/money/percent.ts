/**
 * A percentage with at most 2 decimals as basis points (2.5% = 250n), within
 * [min, max] percent; undefined if it is not one.
 */
export function percentToBasisPoints(
  percent: number,
  min: number,
  max: number,
): bigint | undefined {
  if (!Number.isFinite(percent) || percent < min || percent > max) return undefined;
  const basisPoints = Math.round(percent * 100);
  if (Math.abs(basisPoints - percent * 100) > 1e-9) return undefined;
  return BigInt(basisPoints);
}
