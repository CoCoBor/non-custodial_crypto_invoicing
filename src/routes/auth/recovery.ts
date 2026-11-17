import { Router, type Response } from "express";
import { z } from "zod";

import { provesRecoveryKey } from "../../auth/login-challenge.js";
import * as userFunc from "../../auth/user.function.js";
import { rotateAccountNumber } from "../../auth/user.repository.js";
import { env } from "../../config/env.js";
import { User } from "../../database/users.model.js";
import { authRateLimit } from "../../middleware/auth-rate-limit.js";
import {
  createSession,
  deleteAllSessions,
} from "../../sessions/session.repository.js";

export const recoveryRouter = Router();

recoveryRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// The merchant may have lost the account number, so they are found by the
// public key their browser derives from the 12 words.
const recoverySchema = z.object({
  recoveryPublicKey: z.string().min(1).max(100),
  challenge: z.string().min(1).max(200),
  signature: z.string().min(1).max(200),
});

function refuse(res: Response) {
  return res.status(401).json({
    error: {
      code: "INVALID_CREDENTIALS",
      message: "the recovery key or signature is not valid",
    },
  });
}

/** The merchant who proved the 12 words, or undefined after answering the request. */
async function provenMerchant(body: unknown, res: Response) {
  const parsed = recoverySchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
    return undefined;
  }

  const { recoveryPublicKey, challenge, signature } = parsed.data;
  const user = await userFunc.findUserByRecoveryPublicKey(recoveryPublicKey);
  if (!user || !(await provesRecoveryKey(user, challenge, signature))) {
    refuse(res);
    return undefined;
  }
  return user;
}

recoveryRouter.post("/reset-totp", authRateLimit, async (req, res) => {
  const user = await provenMerchant(req.body, res);
  if (!user) return;

  await User.updateOne(
    { user_id: user.user_id },
    {
      $set: {
        totp_enabled: false,
        totp_secret: null,
        totp_pending_secret: null,
        totp_last_used_step: null,
      },
    },
  ).exec();
  // Whoever held the lost device may hold a session too.
  await deleteAllSessions(user.user_id);

  const { token } = await createSession({
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

recoveryRouter.post("/new-account-number", authRateLimit, async (req, res) => {
  const user = await provenMerchant(req.body, res);
  if (!user) return;

  const accountNumber = await rotateAccountNumber(user.user_id);
  if (!accountNumber) return refuse(res);
  await deleteAllSessions(user.user_id);

  return res.status(201).json({
    data: {
      accountNumber,
      accountNumberDisplay: userFunc.formatAccountNumberForDisplay(accountNumber),
    },
  });
});
