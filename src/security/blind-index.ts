import { createHmac } from "node:crypto";
import { env } from "../config/env.js";

export type LookupPurpose =
  | "account-number"
  | "api-key"
  | "recovery-public-key";

const ALGORITHM = "sha256";
const DOMAIN_SEPARATOR = Buffer.from([0]);

export function computeBlindIndex(
  purpose: LookupPurpose,
  value: string,
): string {
  const hmac = createHmac(ALGORITHM, env.accountLookupHmacKey)
    .update(purpose)
    .update(DOMAIN_SEPARATOR)
    .update(value);

  const blindIndex = hmac.digest("base64url");

  return blindIndex;
}
