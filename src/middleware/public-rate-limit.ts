import { rateLimit } from "express-rate-limit";

import { env } from "../config/env.js";

// The payer's page needs no login, so it is limited per address instead.
export const publicRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: env.nodeEnvironment === "test" ? 10_000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
});
