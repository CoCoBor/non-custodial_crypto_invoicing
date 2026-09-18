import { Router } from "express";

import * as userFunc from "../../auth/user.function.js";
import * as totpRepo from "../../auth/totp.repository.js";
import { buildTotpUri } from "../../auth/totp.function.js";
import { requirePendingTotpSession, requireSession } from "../../middleware/require-session.js";
import { z } from "zod";

export const twoFactorRouter = Router();

twoFactorRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const totpCodeSchema = z.object({
  code: z.string().length(6),
});

twoFactorRouter.post("/setup", requireSession, async (req, res) => {
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

twoFactorRouter.post("/enable", requireSession, async (req, res) => {
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

  const userId = req.session!.userId
  
  const varified = await totpRepo.verifyUserTptp(userId, parsed.data.code)
  
});
