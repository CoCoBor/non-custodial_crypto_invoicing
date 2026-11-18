import type { Response } from "express";

import type { AppDeps } from "../app.js";
import type { AssetId } from "../assets/payout-address.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { askedAmountFor } from "./payer-pays.js";
import { lockPrice, type PriceUnit } from "./pricing.js";

const MINIMUMS = new Map<string, bigint>(
  Object.entries(cryptos).map(([asset, entry]) => {
    if (!/^[1-9][0-9]*$/.test(entry.min_invoice_amount)) {
      throw new Error(`src/storage/cryptos.json: ${asset} needs min_invoice_amount, a positive whole number of smallest units`);
    }
    return [asset, BigInt(entry.min_invoice_amount)];
  }),
);

/** The least an invoice may ask the payer for in `asset`, in its smallest units (spec story 42). */
export function minInvoiceAmount(asset: AssetId): bigint {
  return MINIMUMS.get(asset)!;
}

export function isBelowMinimum(asset: AssetId, asked: bigint): boolean {
  return asked < minInvoiceAmount(asset);
}

export function refuseBelowMinimum(res: Response, asset: AssetId, asked: bigint) {
  return res.status(400).json({
    error: {
      code: "AMOUNT_BELOW_MINIMUM",
      message: `the payer would be asked for ${asked} smallest ${asset} units, below the minimum of ${minInvoiceAmount(asset)}`,
    },
  });
}

/**
 * The coins whose asked amount for this price is at least their minimum. A
 * coin with no price or fee estimate now stays: the payer's choice locks the
 * price and checks again.
 */
export async function coinsAtLeastMinimum(input: {
  coins: AssetId[];
  unit: PriceUnit;
  priceUnits: bigint;
  feePaidByPayer: boolean;
  feeRate: string;
  deps: Pick<AppDeps, "getPrice" | "getUsdToFiat" | "estimateNetworkCost">;
  now: number;
}): Promise<AssetId[]> {
  const keep = await Promise.all(
    input.coins.map(async (coin) => {
      const payment = await lockPrice({
        unit: input.unit,
        priceUnits: input.priceUnits,
        coin,
        getPrice: input.deps.getPrice,
        getUsdToFiat: input.deps.getUsdToFiat,
        now: input.now,
      });
      if (payment === "price_unavailable") return true;
      if (!isBelowMinimum(coin, payment.amount)) return true;
      if (!input.feePaidByPayer) return false;
      const asked = await askedAmountFor({
        coin,
        invoiceAmount: payment.amount,
        feePaidByPayer: true,
        merchantFee: input.feeRate,
        estimateNetworkCost: input.deps.estimateNetworkCost,
      });
      return typeof asked !== "bigint" || !isBelowMinimum(coin, asked);
    }),
  );
  return input.coins.filter((_, i) => keep[i]);
}
