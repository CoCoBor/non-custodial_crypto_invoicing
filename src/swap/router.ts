import type { QuoteAnswer, SwapPort, SwapProvider, SwapRef } from "./swap-port.js";

/**
 * One SwapPort over every provider. A quote goes to the first provider that
 * supports the pair (NEAR first: it keeps every pair it served before
 * Exolix). Status and start go to the provider stored with the swap; any
 * other stored value means NEAR, the only provider before ticket 24.
 */
export function createSwapRouter(providers: Record<SwapProvider, SwapPort>): SwapPort {
  const order = [providers.near_intents, providers.exolix];
  const owner = (swap: SwapRef) => (swap.provider === "exolix" ? providers.exolix : providers.near_intents);

  return {
    supports: (from, to) => order.some((p) => p.supports(from, to)),
    async quote(request): Promise<QuoteAnswer> {
      const provider = order.find((p) => p.supports(request.from, request.to));
      if (provider === undefined) {
        return { kind: "unavailable", reason: `no swap provider swaps ${request.from} into ${request.to}` };
      }
      return await provider.quote(request);
    },
    start: async (deposit) => await owner(deposit).start(deposit),
    status: async (swap) => await owner(swap).status(swap),
  };
}
