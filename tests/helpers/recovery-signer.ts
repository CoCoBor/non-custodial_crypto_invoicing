import { mnemonicToSeedSync } from "@scure/bip39";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

import { loginChallengeMessage, type RecoveryAction } from "../../src/auth/login-challenge.js";

ed.hashes.sha512 = sha512;

/**
 * What the merchant's browser does: derive the key from the 12 words and sign
 * the server's challenge. The words never leave the browser.
 */
export function signChallenge(
  recoveryPhrase: string,
  challenge: string,
  action: RecoveryAction = "login",
): string {
  const privateKey = mnemonicToSeedSync(recoveryPhrase).subarray(0, 32);
  const signature = ed.sign(loginChallengeMessage(challenge, action), privateKey);
  return Buffer.from(signature).toString("base64url");
}
