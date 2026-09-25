import { Router } from "express";

import { z } from "zod";
import * as userFunc from "../../auth/user.function.js";
import * as sessionRepo from "../../sessions/session.repository.js";
import { env } from "../../config/env.js";
import { rateLimit } from "express-rate-limit";

export const loginRouter = Router();

const loginSchema = z.object({
  accountNumber: z.string(),
  //   turnstileToken: z.string().min(1).max(2048),
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: {
    status: 429,
    message: "Too many login attempts. Try again in a minute.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

loginRouter.post("/", loginLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  const accountNumber = userFunc.normaliseAccountNumber(
    parse.data.accountNumber,
  );

  if (!accountNumber) {
    return res.status(401).json({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "the account number is not valid",
      },
    });
  }

  const user = await userFunc.findUserByNumber(accountNumber);

  if (!user) {
    return res.status(401).json({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "the account number is not valid",
      },
    });
  }

  const { user_id, totp_enabled } = user;

  const requiredTwoFactor = totp_enabled;
  const status = totp_enabled ? "pending_totp" : "active";
  const { token } = await sessionRepo.createSession({
    userId: user_id,
    status,
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  res.cookie("session", token, {
    httpOnly: true,
    secure: env.nodeEnvironment === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.status(200).json({
    data: { requiredTwoFactor },
  });
});
