import type { AssetId } from "../assets/payout-address.js";
import { estimateBtcPayoutNetworkCost } from "../transactions/btc.js";
import { TON_PAYOUT_FEE } from "../transactions/ton.js";

/**
 * The network cost a payout is expected to take from a deposit, for
 * payer-pays invoices. Only coins a payer can deposit today have one.
 */
export async function estimatePayoutNetworkCost(
  coin: AssetId,
): Promise<bigint | "unsupported" | undefined> {
  switch (coin) {
    case "btc":
      return await estimateBtcPayoutNetworkCost();
    case "ton":
      // Every TON payout charges exactly this budget as its network cost.
      return TON_PAYOUT_FEE;
    default:
      return "unsupported";
  }
}
