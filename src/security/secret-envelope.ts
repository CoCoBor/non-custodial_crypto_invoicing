import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

export type SecretPurpose =
  | "account-number"
  | "totp-secret"
  | "monero-view-key"
  | "bitcoin-deposit-key"
  | "litecoin-deposit-key"
  | "ethereum-deposit-key"
  | "ethereum-gas-wallet-key"
  | "bsc-gas-wallet-key"
  | "solana-deposit-key"
  | "solana-gas-wallet-key"
  | "ton-deposit-key"
  | "ton-gas-wallet-key"
  | "tron-deposit-key"
  | "tron-gas-wallet-key"
  | "webhook-secret";

export interface SealedSecret {
  keyVersion: number;
  initialisationVector: Buffer;
  authenticationTag: Buffer;
  ciphertext: Buffer;
}

const ALGORITHM = "aes-256-gcm";
const INITIALISATION_VECTOR_BYTE_LENGTH = 12;
const CURRENT_KEY_VERSION = 1;

function readKeyForVersion(version: number): Buffer {
  if (version === 1) {
    return env.dataEncryptionKey;
  }

  throw new Error(`No key is configured for version ${version}`);
}

export function sealSecret(
  purpose: SecretPurpose,
  plaintext: string,
): SealedSecret {
  const initialisationVector = randomBytes(INITIALISATION_VECTOR_BYTE_LENGTH);

  const cipher = createCipheriv(
    ALGORITHM,
    readKeyForVersion(CURRENT_KEY_VERSION),
    initialisationVector,
  );
  cipher.setAAD(Buffer.from(purpose, "utf-8"));
  const cipherText = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authenticationTag = cipher.getAuthTag();

  return {
    keyVersion: CURRENT_KEY_VERSION,
    initialisationVector,
    authenticationTag,
    ciphertext: cipherText,
  };
}

export function openSecret(
  purpose: SecretPurpose,
  sealed: SealedSecret,
): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    readKeyForVersion(sealed.keyVersion),
    sealed.initialisationVector,
  );

  decipher.setAAD(Buffer.from(purpose, "utf-8"));
  decipher.setAuthTag(sealed.authenticationTag);
  const plainText = Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]);

  return plainText.toString("utf-8");
}
