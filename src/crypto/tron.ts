import { Wallet } from "ethers";

import { tronAddressFromEvm } from "../chains/tron-address.js";
import { sealSecret, type SealedSecret } from "../security/secret-envelope.js";
import { formatSealedSecretForEnv } from "./sol.js";

// A Tron key is a secp256k1 key, as on EVM chains: the address is 0x41 plus
// the same 20 bytes, in base58check.

export function generateTronAddress(): { address: string; encryptedPrivateKey: SealedSecret } {
  const wallet = Wallet.createRandom();
  return { address: tronAddressFromEvm(wallet.address), encryptedPrivateKey: sealSecret("tron-deposit-key", wallet.privateKey) };
}

// The gas wallet sends a USDT deposit the TRX its payout burns. Its sealed
// key goes in .env (see src/scripts/create-tron-gas-wallet.ts).
export function generateTronGasWallet(): { address: string; sealedKeyForEnv: string } {
  const wallet = Wallet.createRandom();
  return {
    address: tronAddressFromEvm(wallet.address),
    sealedKeyForEnv: formatSealedSecretForEnv(sealSecret("tron-gas-wallet-key", wallet.privateKey)),
  };
}
