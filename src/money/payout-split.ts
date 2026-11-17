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
 * How a deposit is shared once the network cost paid from it is taken off:
 * the platform gets the fee rate of what is left, rounded up, and the
 * merchant gets the rest. undefined when the network cost uses up the deposit.
 * The merchant's share can be 0; each chain decides what it can still pay.
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
  if (received <= networkCost) return undefined;

  const afterNetwork = received - networkCost;
  const platformFee = ceilDivide(afterNetwork * feeRate, FEE_RATE_SCALE);
  return { platformFee, merchantAmount: afterNetwork - platformFee };
}
