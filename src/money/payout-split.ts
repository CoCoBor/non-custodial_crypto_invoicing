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
 *   platformFee    = ceil((received − feeExempt) × feeRate / FEE_RATE_SCALE)
 *   merchantAmount = received − platformFee − networkCost
 *
 * so platformFee + merchantAmount + networkCost = received, always.
 *
 * `feeExempt` is money among `received` that already paid its fee: a swap's
 * refund that came back to the deposit. The fee is charged once per piece of
 * money (owner decision 2026-11-19); 0 for money that never paid it.
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
  feeExempt?: bigint;
}): { platformFee: bigint; merchantAmount: bigint } | undefined {
  const { received, networkCost, feeRate } = input;
  const feeExempt = input.feeExempt ?? 0n;
  if (received < 0n || networkCost < 0n || feeRate < 0n || feeRate >= FEE_RATE_SCALE || feeExempt < 0n) {
    throw new RangeError("invalid payout split input");
  }

  const charged = received > feeExempt ? received - feeExempt : 0n;
  const platformFee = ceilDivide(charged * feeRate, FEE_RATE_SCALE);
  const merchantAmount = received - platformFee - networkCost;
  if (merchantAmount <= 0n) return undefined;
  return { platformFee, merchantAmount };
}

/**
 * Payer-pays mode: the least a payer must send so that, split by F1 with the
 * estimated network cost, the merchant gets the invoice amount:
 *
 *   asked = ceil((invoiceAmount + estimatedNetworkCost) × SCALE / (SCALE − feeRate))
 *
 * Paying exactly this leaves the merchant exactly invoiceAmount; one unit
 * less leaves them less. The real network cost is only known at payout, and
 * any difference from the estimate is the merchant's.
 */
export function payerPaysAskedAmount(input: {
  invoiceAmount: bigint;
  estimatedNetworkCost: bigint;
  feeRate: bigint;
}): bigint {
  const { invoiceAmount, estimatedNetworkCost, feeRate } = input;
  if (invoiceAmount <= 0n || estimatedNetworkCost < 0n || feeRate < 0n || feeRate >= FEE_RATE_SCALE) {
    throw new RangeError("invalid payer-pays input");
  }
  return ceilDivide((invoiceAmount + estimatedNetworkCost) * FEE_RATE_SCALE, FEE_RATE_SCALE - feeRate);
}
