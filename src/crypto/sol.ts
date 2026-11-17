import { randomBytes } from "node:crypto";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Decoder,
} from "@solana/kit";
import {
  SealedSecret,
  SecretPurpose,
  sealSecret,
} from "../security/secret-envelope.js";

// A new Solana key, as text: base58 of 64 bytes (32-byte private seed, then
// the 32-byte public key). Phantom and Solflare "import private key" accept
// this format, so stuck funds can be moved by hand if the payout code fails.
async function generateSolKey(): Promise<{ address: string; secret: string }> {
  const seed = new Uint8Array(randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);

  const keyPair = new Uint8Array(64);
  keyPair.set(seed, 0);
  keyPair.set(getAddressEncoder().encode(signer.address), 32);
  const secret = getBase58Decoder().decode(keyPair);

  seed.fill(0);
  keyPair.fill(0);

  return { address: signer.address, secret };
}

async function generateSealedSolKey(purpose: SecretPurpose) {
  const { address, secret } = await generateSolKey();
  return { address, sealed: sealSecret(purpose, secret) };
}

// A fresh deposit address for one Solana invoice (SOL, USDT or USDC).
// One address takes all three: a token payment lands in this wallet's
// token account, which the payer's wallet creates.
export async function generateSolAddress(): Promise<{
  address: string;
  encryptedPrivateKey: SealedSecret;
}> {
  const { address, sealed } = await generateSealedSolKey("solana-deposit-key");
  return { address, encryptedPrivateKey: sealed };
}

// The gas wallet pays fees for USDT/USDC payouts. Its sealed key goes in
// .env as SOL_GAS_WALLET_KEY (see src/scripts/create-sol-gas-wallet.ts).
export async function generateSolGasWallet(): Promise<{
  address: string;
  sealedKeyForEnv: string;
}> {
  const { address, sealed } = await generateSealedSolKey("solana-gas-wallet-key");
  return { address, sealedKeyForEnv: formatSealedSecretForEnv(sealed) };
}

// One-line form for .env. readOptionalSealedSecret in config/env.ts reads it.
export function formatSealedSecretForEnv(sealed: SealedSecret): string {
  return [
    String(sealed.keyVersion),
    sealed.initialisationVector.toString("base64"),
    sealed.authenticationTag.toString("base64"),
    sealed.ciphertext.toString("base64"),
  ].join(".");
}
