import { Router } from "express";

import * as userFunc from "../../auth/user.function.js";
import * as totpRepo from "../../auth/totp.repository.js";
import { buildTotpUri } from "../../auth/totp.function.js";
import {
  requirePendingTotpSession,
  requireSession,
  requireTotpSetupSession,
} from "../../middleware/require-session.js";
import { confirmTotpCode } from "../../auth/totp-step-up.js";
import { z } from "zod";
import {
  createSession,
  deleteSession,
} from "../../sessions/session.repository.js";
import { env } from "../../config/env.js";

export const twoFactorRouter = Router();

twoFactorRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const totpCodeSchema = z.object({
  code: z.string().length(6),
});

twoFactorRouter.post("/setup", requireTotpSetupSession, async (req, res) => {
  const userId = req.session!.userId;

  const user = await userFunc.findUserByUserId(userId);

  if (!user) {
    return res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        message: "authentication required",
      },
    });
  }

  if (user.totp_enabled) {
    return res.status(409).json({
      error: {
        code: "TOTP_ALREADY_ENABLED",
        message: "two-factor authentication is already enabled",
      },
    });
  }

  const secret = await totpRepo.prepareUserTotp(userId);
  if (secret === undefined) {
    return res.status(409).json({
      error: {
        code: "TOTP_SETUP_UNAVAILABLE",
        message: "two-factor setup is no longer available",
      },
    });
  }

  res.status(200).json({
    data: { secret, uri: buildTotpUri("merchant", user.user_id, secret) },
  });
});

twoFactorRouter.post("/enable", requireTotpSetupSession, async (req, res) => {
  const parsed = totpCodeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  const userId = req.session!.userId;

  const user = await userFunc.findUserByUserId(userId);

  if (!user) {
    return res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        message: "authentication required",
      },
    });
  }

  if (user.totp_enabled) {
    return res.status(409).json({
      error: {
        code: "TOTP_ALREADY_ENABLED",
        message: "two-factor authentication is already enabled",
      },
    });
  }

  const enable = await totpRepo.enableUserTotp(userId, parsed.data.code);

  if (!enable) {
    return res.status(409).json({
      error: {
        code: "TOTP_ENABLE_FAILED",
        message: "setup is unavailable or the code is not valid",
      },
    });
  }

  // TOTP is on: swap the setup-only session for a full one.
  const oldToken = req.cookies?.session;
  if (oldToken) await deleteSession(oldToken);

  const { token } = await createSession({
    userId,
    status: "active",
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  res.cookie("session", token, {
    httpOnly: true,
    secure: env.nodeEnvironment === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 10 * 60 * 60 * 1000,
  });

  res.status(200).json({
    data: {
      twoFactorEnabled: true,
    },
  });
});

twoFactorRouter.post("/verify", requirePendingTotpSession, async (req, res) => {
  const parsed = totpCodeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: "code must be a six-digit string",
      },
    });
  }

  const userId = req.session!.userId;

  const verified = await totpRepo.verifyUserTptp(userId, parsed.data.code);

  if (!verified)
    return res.status(401).json({
      error: {
        code: "INVALID_TOTP",
        message: "the code is not valid or has already been used",
      },
    });

  const oldToken = req.cookies?.session;
  if (oldToken) await deleteSession(oldToken);

  const { token } = await createSession({
    userId,
    status: "active",
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  res.cookie("session", token, {
    httpOnly: true,
    secure: env.nodeEnvironment === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 10 * 60 * 60 * 1000,
  });

  res.status(200).json({ data: { requiresTwoFactor: false } });
});

// Replacing the authenticator: prove the current device, then confirm a code
// from the new one. Until then the old device keeps working.
twoFactorRouter.post("/replace/start", requireSession, async (req, res) => {
  const userId = req.session!.userId;
  if (!(await confirmTotpCode(userId, req.body?.totpCode, res))) return;

  const user = await userFunc.findUserByUserId(userId);
  const secret = await totpRepo.prepareUserTotp(userId);
  if (!user || secret === undefined) {
    return res.status(409).json({
      error: {
        code: "TOTP_SETUP_UNAVAILABLE",
        message: "two-factor setup is no longer available",
      },
    });
  }

  res.status(200).json({
    data: { secret, uri: buildTotpUri("merchant", user.user_id, secret) },
  });
});

twoFactorRouter.post("/replace/confirm", requireSession, async (req, res) => {
  const parsed = totpCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  const replaced = await totpRepo.replaceUserTotp(req.session!.userId, parsed.data.code);
  if (!replaced) {
    return res.status(409).json({
      error: {
        code: "TOTP_REPLACE_FAILED",
        message: "start the replacement first, or the code is not valid",
      },
    });
  }

  res.status(200).json({ data: { twoFactorEnabled: true } });
});

