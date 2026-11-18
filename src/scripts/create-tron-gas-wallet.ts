// Creates the Tron gas wallet. Run once:
//   npx tsx src/scripts/create-tron-gas-wallet.ts
// It prints the wallet address (send it some TRX for USDT payout fees) and
// the sealed key line for .env. The raw private key is never printed.
import { env } from "../config/env.js";
import { generateTronGasWallet } from "../crypto/tron.js";

if (env.trxGasWalletKey !== undefined) {
  // Replacing the key would lose access to the TRX in the current wallet.
  console.error("TRX_GAS_WALLET_KEY is already set. Move the TRX out of that wallet before replacing it.");
  process.exit(1);
}

const wallet = generateTronGasWallet();

console.log("Gas wallet address (send it some TRX for USDT payout fees):");
console.log(`  ${wallet.address}`);
console.log("");
console.log("Add this line to .env. It is encrypted with DATA_ENCRYPTION_KEY,");
console.log("so it only works together with that key:");
console.log(`TRX_GAS_WALLET_KEY=${wallet.sealedKeyForEnv}`);
