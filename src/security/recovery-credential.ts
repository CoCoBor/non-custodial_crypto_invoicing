import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { sha512 } from "@noble/hashes/sha2.js";
import * as ed from "@noble/ed25519";

ed.hashes.sha512 = sha512;

export interface RecoveryCredential {
  mnemonic: string; //12 word
  publicKey: string;
}

export function generateRecoveryCredential(): RecoveryCredential {
  // default 128= 12 word so 256=24 word
  const mnemonic = generateMnemonic(wordlist, 128);
  const publicKey = derivePublicKeyFromMnemonic(mnemonic);

  if (!publicKey) {
    throw new Error(
      "failed to derive public key from freshly generated mnemonic",
    );
  }

  return {
    mnemonic,
    publicKey,
  };
}

export function derivePublicKeyFromMnemonic(
  mnemonic: string,
): string | undefined {
  if (!validateMnemonic(mnemonic, wordlist)) {
    return undefined;
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const privateKey = seed.subarray(0, 32);
  const publicKeyBytes = ed.getPublicKey(privateKey);

  return Buffer.from(publicKeyBytes).toString("base64url");
}

export function verifyRecoverySignature(
  publicKey: string,
  challenge: Buffer,
  signature: Buffer,
): boolean {
  try {
    const publicKeyBytes = Buffer.from(publicKey, "base64url");
    return ed.verify(signature, challenge, publicKeyBytes);
  } catch {
    return false;
  }
}
