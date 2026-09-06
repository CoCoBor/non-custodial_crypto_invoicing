import { findNetwork } from "../../config/cryptos.js";

export function formatSmallestUnit(amount: number, decimal: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(
      `amount must be a non-negative safe integer, got ${amount}`,
    );
  }
  if (!Number.isInteger(decimal) || decimal < 0) {
    throw new Error(`decimal must be a non-negative integer, got ${decimal}`);
  }

  const padded = String(amount).padStart(decimal + 1, "0");
  // padded.length - decimal is to avoid slice(0,-0)
  const wholePart = padded.slice(0, padded.length - decimal);
  const fractionalPart = padded
    .slice(padded.length - decimal)
    .replace(/0+$/, ""); // "50000000" -> "5"

  return fractionalPart.length > 0
    ? `${wholePart}.${fractionalPart}`
    : wholePart;
}

export function buildPaymentUri(
  address: string,
  amountSatoshi: number,
): string {
  const bitcoin = findNetwork("btc", "bitcoin");
  if (!bitcoin) {
    throw new Error("bitcoin in missing from the asset table");
  }
  return `bitcoin:${address}?amount=${formatSmallestUnit(amountSatoshi, bitcoin.decimals)}`;
}
