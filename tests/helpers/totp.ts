import type { Db } from "mongodb";

import { generateTotpCode } from "../../src/auth/totp.function.js";

/**
 * A TOTP code the server will accept now. Each code's 30-second step can be
 * used only once, so a test that needs several codes in a row first forgets
 * the last used step (a test-only shortcut for waiting 30 seconds).
 */
export async function freshTotpCode(db: Db, userId: string, secret: string): Promise<string> {
  await db.collection("users").updateOne(
    { user_id: userId },
    { $set: { totp_last_used_step: null } },
  );
  return generateTotpCode(secret);
}
