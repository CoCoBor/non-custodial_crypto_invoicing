import { Router } from "express";

import { confirmTotpCode } from "../../auth/totp-step-up.js";
import { issueApiKey } from "../../auth/user.function.js";
import { requireSession } from "../../middleware/require-session.js";

export const apiKeyRouter = Router();

apiKeyRouter.post("/", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const userId = req.session!.userId;
  if (!(await confirmTotpCode(userId, req.body?.totpCode, res))) return;

  const apiKey = await issueApiKey(userId);
  if (!apiKey) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  return res.status(201).json({ data: { apiKey } });
});
