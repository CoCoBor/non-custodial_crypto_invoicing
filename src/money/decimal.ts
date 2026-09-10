export function parseDecimalToScaledInteger(
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