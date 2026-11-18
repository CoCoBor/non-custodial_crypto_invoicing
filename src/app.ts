import express from "express";
import cookieParser from "cookie-parser";

import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { authRouter } from "./routes/auth/index.js";
import { healthRouter } from "./routes/health/index.js";
import { createInvoiceRouters } from "./routes/invoice/index.js";
import { createDashboardRouter } from "./routes/dashboard/index.js";
import { createPayRouter } from "./routes/pay/index.js";
import type { AssetId } from "./assets/payout-address.js";
import type { ChainRegistry } from "./chains/adapter.js";
import { chainAdapters } from "./chains/registry.js";
import * as priceFunc from "./invoice/price.function.js";
import { createUsdToFiat, type FxRate } from "./invoice/fx-rates.js";
import type { FiatCode } from "./storage/currencies.js";
import { env } from "./config/env.js";
import { estimatePayoutNetworkCost } from "./invoice/network-cost.js";
import { settingsRouter } from "./routes/settings/index.js";
import { swapProvider } from "./swap/registry.js";
import type { SwapPort } from "./swap/swap-port.js";
// import { settlementRouter } from "./routes/settlement/index.js";

/** The outside world the routes depend on, so a test can replace it. */
export type AppDeps = {
  getPrice: (coin: AssetId, currency: "usd") => Promise<string | undefined>;
  /**
   * Units of `currency` per US dollar, with the provider's update time.
   * undefined: no source has a rate now. Callers refuse rates older than
   * FX_MAX_AGE_MS (src/invoice/fx-rates.ts).
   */
  getUsdToFiat: (currency: FiatCode) => Promise<FxRate | undefined>;
  /**
   * What paying out one deposit of `coin` is expected to cost in network
   * fees, in its smallest unit, for payer-pays invoices. "unsupported": no
   * estimate for this coin. undefined: not available right now.
   */
  estimateNetworkCost: (coin: AssetId) => Promise<bigint | "unsupported" | undefined>;
  /** The chain adapters a cancel asks for payments. */
  chains: ChainRegistry;
  /** Which coins swap mode can take: only `supports` is used by the routes. */
  swap: SwapPort;
};

const realDeps: AppDeps = {
  getPrice: (coin, currency) => priceFunc.getPrice(coin, currency),
  getUsdToFiat: createUsdToFiat({ apiKey: env.exchangeRateApiKey }),
  estimateNetworkCost: estimatePayoutNetworkCost,
  chains: chainAdapters,
  swap: swapProvider,
};

export function createApp(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = { ...realDeps, ...overrides };
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.use("/health", healthRouter);
  app.use("/auth", authRouter);
  // app.use("/settlement", settlementRouter);
  app.use("/invoices", createInvoiceRouters(deps));
  app.use("/pay", createPayRouter(deps));
  app.use("/settings", settingsRouter);
  app.use("/dashboard", createDashboardRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
