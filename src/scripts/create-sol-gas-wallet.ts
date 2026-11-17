// Creates the Solana gas wallet. Run once:
//   npx tsx src/scripts/create-sol-gas-wallet.ts
// It prints the wallet address (send it a little SOL) and the sealed key
// line for .env. The raw private key is never printed.
import { env } from "../config/env.js";
import { generateSolGasWallet } from "../crypto/sol.js";

if (env.solGasWalletKey !== undefined) {
  // Replacing the key would lose access to the SOL in the current wallet.
  console.error(
    "SOL_GAS_WALLET_KEY is already set. Move the SOL out of that wallet before replacing it.",
  );
  process.exit(1);
}

const wallet = await generateSolGasWallet();

console.log("Gas wallet address (send it about 0.05 SOL):");
console.log(`  ${wallet.address}`);
console.log("");
console.log("Add this line to .env. It is encrypted with DATA_ENCRYPTION_KEY,");
console.log("so it only works together with that key:");
console.log(`SOL_GAS_WALLET_KEY=${wallet.sealedKeyForEnv}`);
