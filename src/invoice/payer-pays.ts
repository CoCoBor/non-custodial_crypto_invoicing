import type { Response } from "express";

import type { AppDeps } from "../app.js";
import type { AssetId } from "../assets/payout-address.js";
import { parseFeeRate, payerPaysAskedAmount } from "../money/payout-split.js";

/**
 * What the payer is asked to send for an invoice of `invoiceAmount` in
 * `coin`: the invoice amount, or in payer-pays mode the invoice amount plus
 * the platform fee plus the estimated network cost. "unsupported": payer-pays
 * with no estimate for this coin. undefined: the estimate is unavailable now.
 */
export async function askedAmountFor(input: {
  coin: AssetId;
  invoiceAmount: bigint;
  feePaidByPayer: boolean;
  merchantFee: string;
  estimateNetworkCost: AppDeps["estimateNetworkCost"];
}): Promise<bigint | "unsupported" | undefined> {
  if (!input.feePaidByPayer) return input.invoiceAmount;

  const feeRate = parseFeeRate(input.merchantFee);
  if (feeRate === undefined) throw new Error("merchant fee rate is invalid");

  const estimate = await input.estimateNetworkCost(input.coin);
  if (estimate === "unsupported" || estimate === undefined) return estimate;

  return payerPaysAskedAmount({
    invoiceAmount: input.invoiceAmount,
    estimatedNetworkCost: estimate,
    feeRate,
  });
}

/** The answer when askedAmountFor gave no amount. */
export function refuseWithoutEstimate(
  res: Response,
  coin: string,
  result: "unsupported" | undefined,
) {
  return result === "unsupported"
    ? res.status(409).json({
        error: {
          code: "PAYER_PAYS_NOT_SUPPORTED",
          message: `payer-pays invoices can't be paid in ${coin} yet`,
        },
      })
    : res.status(503).json({
        error: { code: "NETWORK_FEE_UNAVAILABLE", message: "no network fee estimate" },
      });
}
