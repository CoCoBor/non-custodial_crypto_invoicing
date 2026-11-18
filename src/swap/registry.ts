import type { AssetId } from "../assets/payout-address.js";
import { env } from "../config/env.js";
import { getPrice } from "../invoice/price.function.js";
import { createExolixSwap } from "./exolix.js";
import { createNearIntentsSwap } from "./near.js";
import { createSwapRouter } from "./router.js";
import type { SwapPort } from "./swap-port.js";

/**
 * Every swap provider behind one port. NEAR Intents serves every pair both of
 * whose assets it lists (no XMR); Exolix serves pairs with XMR on one side,
 * when it has an API key.
 */
export function createSwapProvider(config: {
  fetch: typeof globalThis.fetch;
  nearJwt: string;
  exolixApiKey: string;
  now: () => number;
  usdPrice: (asset: AssetId) => Promise<string | undefined>;
}): SwapPort {
  return createSwapRouter({
    near_intents: createNearIntentsSwap({ fetch: config.fetch, jwt: config.nearJwt, now: config.now }),
    exolix: createExolixSwap({ fetch: config.fetch, apiKey: config.exolixApiKey, usdPrice: config.usdPrice }),
  });
}

// The swap port the app and the watcher use.
export const swapProvider: SwapPort = createSwapProvider({
  fetch: (input, init) => fetch(input, init),
  nearJwt: env.nearIntentsJwt,
  exolixApiKey: env.exolixApiKey,
  now: Date.now,
  usdPrice: async (asset) => await getPrice(asset, "usd"),
});
