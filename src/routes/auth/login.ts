import { Router } from "express";
import { z } from "zod";

import { findAccountByNumber } from "../../accounts/account.repository.js";
import { findUserByNumber } from "../../accounts/user.repository.js";
import { env } from "../../config/env.js";
import { getDatabase } from "../../infrastructure/database/mongodb.js";
import { normaliseAccountNumber } from "../../security/secret-generator.js";
import {
  createSession,
  CreateSessionInput,
} from "../../sessions/session.repository.js";

export const loginRouter = Router();

const loginSchema = z.object({
  accountNumber: z.string(),
});

loginRouter.post("/", async (req, res) => {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  const accountNumber = normaliseAccountNumber(parseResult.data.accountNumber);

  if (!accountNumber) {
    return res.status(401).json({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "the account number is not valid",
      },
    });
  }

  const db = getDatabase();

  const user = await findUserByNumber(accountNumber);
  const accountData = user ? null : await findAccountByNumber(db, accountNumber);

  if (!user && !accountData) {
    return res.status(401).json({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "the account number is not valid",
      },
    });
  }

  const _id = user ? user._id : accountData!._id;
  const hasTotpEnable = user ? user.totp_enabled : accountData!.totpSecretCipher !== null;
  const status = hasTotpEnable ? "pending_totp" : "active";
  const requiresTwoFactor = hasTotpEnable;

  const sessionInput: CreateSessionInput = {
    accountId: _id,
    status: status,
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };

  const { token } = await createSession(db, sessionInput);

  res.cookie("session", token, {
    httpOnly: true,
    secure: env.nodeEnvironment === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.setHeader("Cache-Control", "no-store");

  return res.status(200).json({
    data: { requiresTwoFactor },
  });
});
