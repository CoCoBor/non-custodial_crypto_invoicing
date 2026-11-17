import express from "express";
import cookieParser from "cookie-parser";

import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { authRouter } from "./routes/auth/index.js";
import { healthRouter } from "./routes/health/index.js";
import { invoiceRouter } from "./routes/invoice/index.js";
import { settingsRouter } from "./routes/settings/index.js";
// import { settlementRouter } from "./routes/settlement/index.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.use("/health", healthRouter);
  app.use("/auth", authRouter);
  // app.use("/settlement", settlementRouter);
  app.use("/invoices", invoiceRouter);
  app.use("/settings", settingsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
