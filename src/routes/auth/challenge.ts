import { Router } from "express";
import { z } from "zod";

import { issueLoginChallenge } from "../../auth/login-challenge.js";
import * as userFunc from "../../auth/user.function.js";
import { authRateLimit } from "../../middleware/auth-rate-limit.js";

export const challengeRouter = Router();

const challengeSchema = z.object({ accountNumber: z.string().max(64) });

challengeRouter.post("/", authRateLimit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parsed = challengeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  const accountNumber = userFunc.normaliseAccountNumber(parsed.data.accountNumber);
  const user = accountNumber ? await userFunc.findUserByNumber(accountNumber) : null;
  const challenge = await issueLoginChallenge(user?.user_id ?? undefined);

  return res.status(200).json({ data: { challenge } });
});
