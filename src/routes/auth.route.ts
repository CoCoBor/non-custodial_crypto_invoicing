import { Router } from "express";
import { getDatabase } from "../infrastructure/database/mongodb.js";
import {
  createAccount,
  findAccountById,
  findAccountByNumber,
} from "../accounts/account.repository.js";
import {
  formatAccountNumberForDisplay,
  hashBearerToken,
  normaliseAccountNumber,
} from "../security/secret-generator.js";
import { z } from "zod";
import {
  createSession,
  CreateSessionInput,
  deleteSession,
} from "../sessions/session.repository.js";
import { env } from "../config/env.js";
import { requireSession } from "../middleware/require-session.js";

export const authRouter = Router();

const loginSchema = z.object({
  accountNumber: z.string(),
});

authRouter.post("/register", async (_req, res) => {
  const db = getDatabase();
  const { accountNumber, mnemonic } = await createAccount(db);

  res.set("Cache-Control", "no-store");
  res.status(201).json({
    data: {
      accountNumber,
      accountNumberDisplay: formatAccountNumberForDisplay(accountNumber),
      recoveryPhrase: mnemonic,
    },
  });
});

authRouter.post("/login", async (req, res) => {
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

  const accountData = await findAccountByNumber(db, accountNumber);

  if (!accountData) {
    return res.status(401).json({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "the account number is not valid",
      },
    });
  }

  const { _id, totpSecretCipher } = accountData;

  const hasTotpEnable = totpSecretCipher !== null;
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

authRouter.get("/session", requireSession, async (req, res) => {
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

authRouter.post("/logout", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const token = req.cookies?.session;

  if (token) {
    const db = getDatabase();
    await deleteSession(db, token);
  }

  res.clearCookie("session", {
    httpOnly: true,
    secure: env.nodeEnvironment === "production",
    sameSite: "strict",
    path: "/",
  });

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    data: {
      loggedOut: true,
    },
  });
});
