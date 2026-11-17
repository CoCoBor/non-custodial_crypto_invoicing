import type { AssetId } from "../assets/payout-address.js";
import type { ChainRegistry } from "../chains/adapter.js";
import { chainAdapters } from "../chains/registry.js";

/**
 * The network cost a payout is expected to take from a deposit, for
 * payer-pays invoices. Only coins a payer can deposit today have one.
 */
export async function estimatePayoutNetworkCost(
  coin: AssetId,
  registry: ChainRegistry = chainAdapters,
): Promise<bigint | "unsupported" | undefined> {
  const chain = registry[coin];
  if (chain === undefined) return "unsupported";
  return await chain.estimateNetworkCost();
}
