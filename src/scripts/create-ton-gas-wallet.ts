// Creates the TON gas wallet for jetton (USDT on TON) payouts. Run once:
//   npx tsx src/scripts/create-ton-gas-wallet.ts
// It prints the wallet address (send it some TON) and the sealed key line
// for .env. The mnemonic is never printed.
import { env } from "../config/env.js";
import { generateTonGasWallet } from "../crypto/ton.js";

if (env.tonGasWalletKey !== undefined) {
  // Replacing the key would lose access to the TON in the current wallet.
  console.error("TON_GAS_WALLET_KEY is already set. Move the TON out of that wallet before replacing it.");
  process.exit(1);
}

const wallet = await generateTonGasWallet();

console.log("Gas wallet address (send it a few TON; its first top-up deploys it):");
console.log(`  ${wallet.address}`);
console.log("");
console.log("Add this line to .env. It is encrypted with DATA_ENCRYPTION_KEY,");
console.log("so it only works together with that key:");
console.log(`TON_GAS_WALLET_KEY=${wallet.sealedKeyForEnv}`);
