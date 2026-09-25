export function formatSmallestUnit(
  amount: number | bigint,
  decimal: number,
): string {
  if (
    typeof amount === "number" &&
    (!Number.isSafeInteger(amount) || amount < 0)
  ) {
    throw new RangeError(`amount must be a non-negative safe integer`);
  }

  if (typeof amount === "bigint" && amount < 0n) {
    throw new RangeError("amount must be non-negative");
  }

  if (!Number.isInteger(decimal) || decimal < 0 || decimal > 36) {
    throw new RangeError(
      `decimal must be a non-negative integer, got ${decimal}`,
    );
  }

  const padded = String(amount).padStart(decimal + 1, "0");
  // padded.length - decimal is to avoid slice(0,-0)
  const decimalPosition = padded.length - decimal
  const wholePart = padded.slice(0, decimalPosition);
  const fractionalPart = padded
    .slice(decimalPosition)
    .replace(/0+$/, ""); // "50000000" -> "5"

  return fractionalPart.length > 0
    ? `${wholePart}.${fractionalPart}`
    : wholePart;
}

export function ceilDivide(
  amount: bigint,
  divisor: bigint,
): bigint {
  if (amount < 0n || divisor <= 0n) {
    throw new RangeError(
      "amount must be non-negative and divisor must be positive",
    );
  }

  return (amount + divisor - 1n) / divisor;
}