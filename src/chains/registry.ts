import { ASSET_IDS, isAssetId, type AssetId } from "../assets/payout-address.js";
import { env } from "../config/env.js";
import type { ChainAdapter, ChainRegistry } from "./adapter.js";
import { createBtcAdapter } from "./btc.js";
import { createLtcAdapter } from "./ltc.js";
import { createTonAdapter } from "./ton.js";

// One line per deposit asset. A payer can be offered, and the watcher only
// follows, the assets listed here.
export const chainAdapters: ChainRegistry = {
  btc: createBtcAdapter({ platformAddress: env.platformBtcAddress }),
  ltc: createLtcAdapter({ platformAddress: env.platformLtcAddress }),
  ton: createTonAdapter({ platformAddress: env.platformTonAddress }),
};

export function depositAssets(registry: ChainRegistry = chainAdapters): AssetId[] {
  return ASSET_IDS.filter((asset) => registry[asset] !== undefined);
}

export function adapterFor(
  asset: string,
  registry: ChainRegistry = chainAdapters,
): ChainAdapter | undefined {
  return isAssetId(asset) ? registry[asset] : undefined;
}
