// Creates the gas wallet for one EVM chain. Run once per chain:
//   npx tsx src/scripts/create-evm-gas-wallet.ts eth
//   npx tsx src/scripts/create-evm-gas-wallet.ts bsc
// It prints the wallet address (send it some ETH or BNB) and the sealed key
// line for .env. The raw private key is never printed.
import { env } from "../config/env.js";
import { generateEvmGasWallet } from "../crypto/eth.js";

const chains = {
  eth: { variable: "ETH_GAS_WALLET_KEY", purpose: "ethereum-gas-wallet-key", coin: "ETH", current: env.ethGasWalletKey },
  bsc: { variable: "BSC_GAS_WALLET_KEY", purpose: "bsc-gas-wallet-key", coin: "BNB", current: env.bscGasWalletKey },
} as const;

const name = process.argv[2];
if (name !== "eth" && name !== "bsc") {
  console.error("Usage: npx tsx src/scripts/create-evm-gas-wallet.ts eth|bsc");
  process.exit(1);
}
const chain = chains[name];

if (chain.current !== undefined) {
  // Replacing the key would lose access to the coin in the current wallet.
  console.error(`${chain.variable} is already set. Move the ${chain.coin} out of that wallet before replacing it.`);
  process.exit(1);
}

const wallet = generateEvmGasWallet(chain.purpose);

console.log(`Gas wallet address (send it some ${chain.coin} for token payout gas):`);
console.log(`  ${wallet.address}`);
console.log("");
console.log("Add this line to .env. It is encrypted with DATA_ENCRYPTION_KEY,");
console.log("so it only works together with that key:");
console.log(`${chain.variable}=${wallet.sealedKeyForEnv}`);
