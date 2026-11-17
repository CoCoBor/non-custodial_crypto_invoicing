import type { Response } from "express";

import { verifyUserTptp } from "./totp.repository.js";

/**
 * A critical change (addresses, webhook, API key, new authenticator) needs a
 * fresh code from the merchant's authenticator, even inside a full session.
 * False after the request has been answered.
 */
export async function confirmTotpCode(
  userId: string,
  code: unknown,
  res: Response,
): Promise<boolean> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    res.status(401).json({
      error: {
        code: "TOTP_REQUIRED",
        message: "this change needs a code from your authenticator",
      },
    });
    return false;
  }

  if (!(await verifyUserTptp(userId, code))) {
    res.status(401).json({
      error: {
        code: "INVALID_TOTP",
        message: "the code is not valid or has already been used",
      },
    });
    return false;
  }

  return true;
}
