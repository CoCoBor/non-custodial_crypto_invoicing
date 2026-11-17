import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "./format.js";

// Fee rates are exact integers with 8 decimals: "0.05" (5%) = 5_000_000n.
export const FEE_RATE_DECIMALS = 8;
export const FEE_RATE_SCALE = 10n ** BigInt(FEE_RATE_DECIMALS);

/** A merchant fee rate from text, or undefined unless it is from 0% up to (not including) 100%. */
export function parseFeeRate(text: string): bigint | undefined {
  const rate = decimalStrToBigInt(text, FEE_RATE_DECIMALS);
  return rate === undefined || rate >= FEE_RATE_SCALE ? undefined : rate;
}

/**
 * How a deposit is shared (rule F1). The platform fee is the fee rate of
 * everything received, rounded up; every network cost comes out of the
 * merchant's share:
 *
 *   platformFee    = ceil(received × feeRate / FEE_RATE_SCALE)
 *   merchantAmount = received − platformFee − networkCost
 *
 * so platformFee + merchantAmount + networkCost = received, always.
 *
 * undefined means "too small to forward": the fee plus the network cost
 * leave the merchant 0 or less. A result always has merchantAmount ≥ 1.
 * A chain may still refuse a positive share below its own dust or rent
 * limit.
 */
export function splitPayout(input: {
  received: bigint;
  networkCost: bigint;
  feeRate: bigint;
}): { platformFee: bigint; merchantAmount: bigint } | undefined {
  const { received, networkCost, feeRate } = input;
  if (received < 0n || networkCost < 0n || feeRate < 0n || feeRate >= FEE_RATE_SCALE) {
    throw new RangeError("invalid payout split input");
  }

  const platformFee = ceilDivide(received * feeRate, FEE_RATE_SCALE);
  const merchantAmount = received - platformFee - networkCost;
  if (merchantAmount <= 0n) return undefined;
  return { platformFee, merchantAmount };
}
