import { Router } from "express";

import { findAccountById } from "../../accounts/account.repository.js";
import { getDatabase } from "../../infrastructure/database/mongodb.js";
import { requireSession } from "../../middleware/require-session.js";

export const sessionRouter = Router();

sessionRouter.get("/", requireSession, async (req, res) => {
  const db = getDatabase();
  const account = await findAccountById(db, req.session!.accountId);
  if (!account) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  const { totpSecretCipher, createdAt } = account;

  res.set("Cache-Control", "no-store");
  res.status(200).json({
    data: {
      twoFactorEnabled: totpSecretCipher !== null,
      memberSince: createdAt.toISOString(),
      sessionExpiresAt: req.session!.expiresAt.toISOString(),
    },
  });
});
