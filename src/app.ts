import express from "express";
import cookieParser from "cookie-parser";

import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { authRouter } from "./routes/auth/index.js";
import { healthRouter } from "./routes/health/index.js";
import { createInvoiceRouters } from "./routes/invoice/index.js";
import { createPayRouter } from "./routes/pay/index.js";
import type { AssetId } from "./assets/payout-address.js";
import * as priceFunc from "./invoice/price.function.js";
import { settingsRouter } from "./routes/settings/index.js";
// import { settlementRouter } from "./routes/settlement/index.js";

/** The outside world the routes depend on, so a test can replace it. */
export type AppDeps = {
  getPrice: (coin: AssetId, currency: "usd") => Promise<string | undefined>;
};

const realDeps: AppDeps = {
  getPrice: (coin, currency) => priceFunc.getPrice(coin, currency),
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
