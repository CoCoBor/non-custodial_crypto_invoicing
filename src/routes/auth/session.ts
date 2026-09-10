import { Router } from "express";

import { findUserById } from "../../accounts/user.repository.js";
import { requireSession } from "../../middleware/require-session.js";

export const sessionRouter = Router();

sessionRouter.get("/", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const user = await findUserById(req.session!.accountId);

  if (!user) {
    return res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        message: "authentication required",
      },
    });
  }

  return res.status(200).json({
    data: {
      userId: user.user_id,
      twoFactorEnabled: user.totp_enabled,
      memberSince:
        user.member_since == null
          ? null
          : new Date(user.member_since).toISOString(),
      sessionExpiresAt: req.session!.expiresAt.toISOString(),
    },
  });
});
