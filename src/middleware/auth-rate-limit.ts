import { rateLimit } from "express-rate-limit";

import { env } from "../config/env.js";

// One budget for every login step (challenge, recovery login, account-number
// login), per address. Tests make many logins from 127.0.0.1.
export const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: env.nodeEnvironment === "test" ? 1_000 : 5,
  message: {
    status: 429,
    message: "Too many login attempts. Try again in a minute.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
