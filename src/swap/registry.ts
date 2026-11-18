import { env } from "../config/env.js";
import { createNearIntentsSwap } from "./near.js";
import type { SwapPort } from "./swap-port.js";

// The swap provider the app and the watcher use. NEAR Intents serves every
// pair both of whose assets it lists (no XMR). Ticket 24 adds Exolix for XMR
// here: a SwapPort that tries each provider whose supports(from, to) is true.
export const swapProvider: SwapPort = createNearIntentsSwap({
  fetch: (input, init) => fetch(input, init),
  jwt: env.nearIntentsJwt,
  now: Date.now,
});
