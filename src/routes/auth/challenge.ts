import { Router } from "express";
import { z } from "zod";

import { issueLoginChallenge } from "../../auth/login-challenge.js";
import * as userFunc from "../../auth/user.function.js";
import { authRateLimit } from "../../middleware/auth-rate-limit.js";

export const challengeRouter = Router();

// The merchant names themselves by account number (first login), or by the
// public key from their 12 words (recovery, when the number may be lost).
const challengeSchema = z.union([
  z.object({ accountNumber: z.string().max(64) }),
  z.object({ recoveryPublicKey: z.string().min(1).max(100) }),
]);

challengeRouter.post("/", authRateLimit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parsed = challengeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  let user;
  if ("accountNumber" in parsed.data) {
    const accountNumber = userFunc.normaliseAccountNumber(parsed.data.accountNumber);
    user = accountNumber ? await userFunc.findUserByNumber(accountNumber) : null;
  } else {
    user = await userFunc.findUserByRecoveryPublicKey(parsed.data.recoveryPublicKey);
  }
  const challenge = await issueLoginChallenge(user?.user_id ?? undefined);

  return res.status(200).json({ data: { challenge } });
});
