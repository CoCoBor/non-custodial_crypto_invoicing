import { Router } from "express";
import { getDatabase } from "../infrastructure/database/mongodb.js";
import {
  completeTotpEnrolment,
  consumeTotpStep,
  createAccount,
  findAccountById,
  findAccountByNumber,
  startTotpEnrolment,
} from "../accounts/account.repository.js";
import {
  formatAccountNumberForDisplay,
  normaliseAccountNumber,
} from "../security/secret-generator.js";
import { z } from "zod";
import {
  createSession,
  CreateSessionInput,
  deleteSession,
} from "../sessions/session.repository.js";
import { env } from "../config/env.js";
import {
  requirePendingTotpSession,
  requireSession,
} from "../middleware/require-session.js";
import { openSecret, sealSecret } from "../security/secret-envelope.js";
import {
  buildTotpUri,
  generateTotpSecret,
  verifyTotpCode,
} from "../security/totp.js";

export const authRouter = Router();

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

const loginSchema = z.object({
  accountNumber: z.string(),
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

authRouter.post("/2fa/setup", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const db = getDatabase();
  const accountId = req.session!.accountId;
  const account = await findAccountById(db, accountId);
  if (!account) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  const { totpSecretCipher, publicId } = account;

  if (totpSecretCipher !== null) {
    return res.status(409).json({
      error: {
        code: "CONFLICT",
        message: "two-factor authentication is already enabled",
      },
    });
  }

  const secret = generateTotpSecret();
  const sealed = sealSecret("totp-secret", secret);
  await startTotpEnrolment(db, accountId, sealed);
  const uri = buildTotpUri("merchant", publicId, secret);

  res.status(200).json({
    data: {
      secret,
      uri,
    },
  });
});

const totpCodeSchema = z.object({
  code: z.string(),
});

authRouter.post("/2fa/enable", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parseResult = totpCodeSchema.safeParse(req.body);

  const db = getDatabase();
  const accountId = req.session!.accountId;
  const account = await findAccountById(db, accountId);

  if (!parseResult.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }
  if (!account) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  const { totpPendingCipher, totpSecretCipher } = account;

  if (!totpPendingCipher) {
    return res.status(409).json({
      error: {
        code: "CONFLICT",
        message: "no pending two-factor setup",
      },
    });
  }

  if (totpSecretCipher) {
    return res.status(409).json({
      error: {
        code: "CONFLICT",
        message: "already enable",
      },
    });
  }

  const secret = openSecret("totp-secret", totpPendingCipher);

  const step = verifyTotpCode(secret, parseResult.data.code);
  if (step === undefined) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "the code is not valid" },
    });
  }

  const consume = await consumeTotpStep(db, accountId, step);
  if (!consume) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "the code is not valid" },
    });
  }

  await completeTotpEnrolment(db, accountId);

  res.status(200).json({
    data: {
      twoFactorEnabled: true,
    },
  });
});

authRouter.post("/2fa/verify", requirePendingTotpSession, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parseResult = totpCodeSchema.safeParse(req.body);

  const db = getDatabase();
  const accountId = req.session!.accountId;
  const account = await findAccountById(db, accountId);

  if (!parseResult.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }
  if (!account || !account.totpSecretCipher) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  const { totpSecretCipher } = account;

  const secret = openSecret("totp-secret", totpSecretCipher);

  const step = verifyTotpCode(secret, parseResult.data.code);
  if (step === undefined) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "the code is not valid" },
    });
  }

  const consume = await consumeTotpStep(db, accountId, step);
  if (!consume) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "the code is not valid" },
    });
  }

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
