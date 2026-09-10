import { findNetwork } from "../../config/cryptos.js";
import { formatSmallestUnit } from "../../money/format.js";

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
