import { Request } from "express";
import { User } from "../database/users.model.js";
import { computeBlindIndex } from "../security/blind-index.js";
import { randomUUID } from "crypto";

export async function findUserByUserId(userId: string) {
  return await User.findOne({ user_id: userId }).exec();
}

export function normaliseAccountNumber(input: string): string | undefined {
  const cleaned: string = input.replaceAll("-", "").replace(/\s/g, "");
  if (!cleaned.match(/^[0-9]{16}$/)) {
    return undefined;
  }
  return cleaned;
}

export function formatAccountNumberForDisplay(accountNumber: string): string {
  const matches = accountNumber.match(/.{1,4}/g);
  const result: string = matches ? matches.join("-") : "";

  return result;
}

export async function findUserByRecoveryPublicKey(recoveryPublicKey: string) {
  return await User.findOne({ recovery_public_key: recoveryPublicKey }).exec();
}

export async function findUserByNumber(accountNumber: string) {
  return await User.findOne({
    account_hash: computeBlindIndex("account-number", accountNumber),
  }).exec();
}

export function getClientIp(req: Request): string | undefined {
  const cfHeader = req.headers["cf-connecting-ip"];
  const forwardedHeader = req.headers["x-forwarded-for"];

  const cfIp = Array.isArray(cfHeader) ? cfHeader[0] : cfHeader;
  const forwarded = Array.isArray(forwardedHeader)
    ? forwardedHeader[0]
    : forwardedHeader;

  return (
    cfIp?.trim() ||
    forwarded?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    req.ip
  );
}

export async function validateTurnstile(
  token: string,
  remoteip: string | undefined,
  expectedAction: string,
): Promise<boolean> {
  const secret = process.env.SITE_SECRET;
  const hostname = process.env.TURNSTILE_HOSTNAME;

  if (!secret || !hostname) {
    throw new Error("Turnstile configuration is missing");
  }

  const idempotencyKey = randomUUID();

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const formData = new FormData();

      formData.append("secret", secret);
      formData.append("response", token);
      formData.append("idempotency_key", idempotencyKey);

      if (remoteip) {
        formData.append("remoteip", remoteip);
      }

      const response = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          body: formData,
          signal: AbortSignal.timeout(5_000),
        },
      );

      if (!response.ok) {
        throw new Error("Turnstile request failed");
      }

      const result = await response.json();

      return (
        result?.success === true &&
        result.action === expectedAction &&
        result.hostname === hostname
      );
    } catch {
      if (attempt === 3) return false;

      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }

  return false;
}

export function findUserByMerchantKey(apiKey: string) {
  return User.findOne({
    api_key_hash: computeBlindIndex("api-key", apiKey),
  }).exec();
}

/** A new API key for the merchant, replacing any old one. Shown once: only its keyed hash is stored. */
export async function issueApiKey(userId: string): Promise<string | undefined> {
  const apiKey = randomUUID();
  const result = await User.updateOne(
    { user_id: userId },
    { $set: { api_key_hash: computeBlindIndex("api-key", apiKey) } },
  ).exec();
  return result.matchedCount === 1 ? apiKey : undefined;
}