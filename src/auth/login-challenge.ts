import { createHash, randomBytes } from "node:crypto";

import { LoginChallenge } from "../database/login-challenge.model.js";
import { verifyRecoverySignature } from "../security/recovery-credential.js";

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

function hashChallenge(challenge: string): string {
  return createHash("sha256").update(challenge).digest("base64url");
}

/**
 * The bytes the merchant's browser signs with the key from the 12 words. The
 * prefix ties a signature to this use, so it can't be replayed elsewhere.
 */
export function loginChallengeMessage(challenge: string): Buffer {
  return Buffer.from(`merchant-v3 login:${challenge}`, "utf8");
}

/**
 * A one-time challenge for this merchant. An unknown account still gets one
 * (never stored), so the endpoint can't be used to find accounts.
 */
export async function issueLoginChallenge(
  userId: string | undefined,
  now = Date.now(),
): Promise<string> {
  const challenge = randomBytes(32).toString("base64url");
  if (userId) {
    await LoginChallenge.create({
      challengeHash: hashChallenge(challenge),
      userId,
      expiresAt: new Date(now + CHALLENGE_LIFETIME_MS),
    });
  }
  return challenge;
}

/** Uses the challenge up. True only if it was issued to this merchant and has not expired. */
export async function consumeLoginChallenge(
  userId: string,
  challenge: string,
  now = Date.now(),
): Promise<boolean> {
  const used = await LoginChallenge.findOneAndDelete({
    challengeHash: hashChallenge(challenge),
    userId,
    expiresAt: { $gt: new Date(now) },
  }).exec();
  return used !== null;
}

/**
 * True when the signature over a fresh challenge issued to this merchant was
 * made with the key from their 12 words. Uses the challenge up either way.
 */
export async function provesRecoveryKey(
  user: { user_id: string; recovery_public_key?: string | null },
  challenge: string,
  signature: string,
): Promise<boolean> {
  if (!user.recovery_public_key) return false;
  const fresh = await consumeLoginChallenge(user.user_id, challenge);
  return (
    fresh &&
    verifyRecoverySignature(
      user.recovery_public_key,
      loginChallengeMessage(challenge),
      Buffer.from(signature, "base64url"),
    )
  );
}
