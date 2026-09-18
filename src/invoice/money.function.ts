

export function decimalStrToBigInt(
  value: string,
  scale: number,
): bigint | undefined {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36) {
    throw new Error("scale must be an integer between 0 and 36");
  }

  const decimal = value.trim();

  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(decimal)) return undefined;

  const [wholePart, fractionalPart = ""] = decimal.split(".");

  if (fractionalPart.length > scale) return undefined;

  const paddedFraction = fractionalPart.padEnd(scale, "0");

  const scaledDigits = wholePart + paddedFraction;

  return BigInt(scaledDigits);
}

export function intToDecimalStr(
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



