import { Router } from "express";

import { z } from "zod";
import * as userFunc from "../../auth/user.function.js";
import * as sessionRepo from "../../sessions/session.repository.js";
import { env } from "../../config/env.js";
import { authRateLimit } from "../../middleware/auth-rate-limit.js";
import { provesRecoveryKey } from "../../auth/login-challenge.js";

export const loginRouter = Router();

const loginSchema = z.object({
  accountNumber: z.string(),
  //   turnstileToken: z.string().min(1).max(2048),
});

loginRouter.post("/", authRateLimit, async (req, res) => {
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

  // Without TOTP the account number alone would be the only secret.
  if (!totp_enabled) {
    return res.status(409).json({
      error: {
        code: "RECOVERY_PHRASE_REQUIRED",
        message: "the first login needs your recovery phrase",
      },
    });
  }

  const requiredTwoFactor = totp_enabled;
  const { token } = await sessionRepo.createSession({
    userId: user_id,
    status: "pending_totp",
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

const recoveryLoginSchema = z.object({
  accountNumber: z.string().max(64),
  challenge: z.string().min(1).max(200),
  signature: z.string().min(1).max(200),
});

// First login, before TOTP exists: the merchant's browser signs the challenge
// with the key from the 12 words. The session it gives can only set up TOTP.
loginRouter.post("/recovery", authRateLimit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parsed = recoveryLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  const refuse = () =>
    res.status(401).json({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "the account number or signature is not valid",
      },
    });

  const accountNumber = userFunc.normaliseAccountNumber(parsed.data.accountNumber);
  if (!accountNumber) return refuse();

  const user = await userFunc.findUserByNumber(accountNumber);
  if (!user) return refuse();

  const { challenge, signature } = parsed.data;
  if (!(await provesRecoveryKey(user, challenge, signature, "login"))) return refuse();

  if (user.totp_enabled) {
    return res.status(409).json({
      error: {
        code: "USE_TOTP_LOGIN",
        message: "log in with your account number and authenticator code",
      },
    });
  }

  const { token } = await sessionRepo.createSession({
    userId: user.user_id,
    status: "totp_setup",
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

  return res.status(200).json({ data: { next: "totp_setup" } });
});
