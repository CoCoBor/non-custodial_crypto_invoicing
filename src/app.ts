import express from "express";

import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { healthRouter } from "./routes/health.route.js";
import { authRouter } from "./routes/auth.route.js";
import cookieParser from "cookie-parser";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.use(cookieParser())
  app.use("/health", healthRouter);
  app.use("/auth", authRouter)

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
