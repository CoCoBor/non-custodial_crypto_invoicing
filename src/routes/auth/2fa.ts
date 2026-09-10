import { Router } from "express";
import { findUserById } from "../../accounts/user.repository.js";
import { z } from "zod";

import { env } from "../../config/env.js";
import { getDatabase } from "../../infrastructure/database/mongodb.js";
import {
  requirePendingTotpSession,
  requireSession,
} from "../../middleware/require-session.js";
import { buildTotpUri } from "../../security/totp.js";
import {
  createSession,
  deleteSession,
} from "../../sessions/session.repository.js";
import * as UserTotp from "../../accounts/user-totp.repository.js";

export const twoFactorRouter = Router();

const totpCodeSchema = z.object({
  code: z.string(),
});

twoFactorRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

twoFactorRouter.post("/setup", requireSession, async (req, res) => {
  const accountId = req.session!.accountId;
  const user = await findUserById(accountId);

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

  const secret = await UserTotp.prepareUserTotp(accountId);
  if (secret === undefined) {
    return res.status(409).json({
      error: {
        code: "TOTP_SETUP_UNAVAILABLE",
        message: "two-factor setup is no longer available",
      },
    });
  }

  res.status(200).json({
    data: {
      secret,
      uri: buildTotpUri("merchant", user.user_id, secret),
    },
  });
});

twoFactorRouter.post("/enable", requireSession, async (req, res) => {
  const parsed = totpCodeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }
  const accountId = req.session!.accountId;
  const user = await findUserById(accountId);
  if (!user) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
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

  const enable = await UserTotp.enableUserTotp(accountId, parsed.data.code);

  if (!enable) {
    return res.status(409).json({
      error: {
        code: "TOTP_ENABLE_FAILED",
        message: "setup is unavailable or the code is not valid",
      },
    });
  }

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
  const accountId = req.session!.accountId;

  const verified = await UserTotp.verifyUserTotp(accountId, parsed.data.code);

  if (!verified) {
    return res.status(401).json({
      error: {
        code: "INVALID_TOTP",
        message: "the code is not valid or has already been used",
      },
    });
  }

  const db = getDatabase();
  const oldToken = req.cookies?.session;

  if (oldToken) {
    await deleteSession(db, oldToken);
  }

  const { token } = await createSession(db, {
    accountId,
    status: "active",
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
    data: {
      requiresTwoFactor: false,
    },
  });
});
