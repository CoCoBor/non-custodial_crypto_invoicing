import { Router } from "express";

import { issueApiKey } from "../../auth/user.function.js";
import { requireSession } from "../../middleware/require-session.js";

export const apiKeyRouter = Router();

apiKeyRouter.post("/", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const apiKey = await issueApiKey(req.session!.userId);
  if (!apiKey) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  return res.status(201).json({ data: { apiKey } });
});
