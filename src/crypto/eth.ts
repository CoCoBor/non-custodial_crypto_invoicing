import { Wallet } from "ethers";
import { SealedSecret, sealSecret } from "../security/secret-envelope.js";
import { formatSealedSecretForEnv } from "./sol.js";

// One generator for every EVM chain (Ethereum, BNB Smart Chain): the same
// key and address work on both.
export function generateEthAddress(): {
  address: string;
  encryptedPrivateKey: SealedSecret;
} {
  const wallet = Wallet.createRandom();

  return {
    address: wallet.address,
    encryptedPrivateKey: sealSecret("ethereum-deposit-key", wallet.privateKey),
  };
}

// A gas wallet tops up token deposits on one EVM chain. Its sealed key goes
// in .env (see src/scripts/create-evm-gas-wallet.ts).
export function generateEvmGasWallet(purpose: "ethereum-gas-wallet-key" | "bsc-gas-wallet-key"): {
  address: string;
  sealedKeyForEnv: string;
} {
  const wallet = Wallet.createRandom();
  return { address: wallet.address, sealedKeyForEnv: formatSealedSecretForEnv(sealSecret(purpose, wallet.privateKey)) };
}
