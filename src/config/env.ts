import "dotenv/config";
import { isAddress as isSolAddress } from "@solana/kit";
import { Address as TonAddress } from "@ton/core";
import litecore from "bitcore-lib-ltc";
import { getAddress, isAddress } from "ethers";
// Type only: importing the module itself would loop (secret-envelope imports env).
import type { SealedSecret } from "../security/secret-envelope.js";


const DEFAULT_PORT = 3000;

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

function readNodeEnvironment(
  value: string | undefined,
): "development" | "test" | "production" {
  if (value === undefined) {
    return "development";
  }

  if (value === "development" || value === "test" || value === "production") {
    return value;
  }

  throw new Error("NODE_ENV must be one of: development, test, or production");
}

export const env = Object.freeze({
  nodeEnvironment: readNodeEnvironment(process.env.NODE_ENV),
  port: readPort(process.env.PORT),

  mongodbUri: readRequiredString("MONGODB_URI", process.env.MONGODB_URI),
  mongodbDatabase: readRequiredString(
    "MONGODB_DATABASE",
    process.env.MONGODB_DATABASE,
  ),

  dataEncryptionKey: readBase64Key(
    "DATA_ENCRYPTION_KEY",
    process.env.DATA_ENCRYPTION_KEY,
  ),

  accountLookupHmacKey: readBase64Key(
    "ACCOUNT_LOOKUP_HMAC_KEY",
    process.env.ACCOUNT_LOOKUP_HMAC_KEY,
  ),

  nowNodesApiKey: readRequiredString(
    "NOWNODES_API_KEY",
    process.env.NOWNODES_API_KEY,
  ),

  platformBtcAddress: readRequiredString(
    "PLATFORM_BTC_ADDRESS",
    process.env.PLATFORM_BTC_ADDRESS,
  ),

  platformEthAddress: readEthAddress(
    "PLATFORM_ETH_ADDRESS",
    process.env.PLATFORM_ETH_ADDRESS
  ),

  // Receives the platform fee for BNB and BEP-20 tokens on BNB Smart Chain.
  // Optional so the server starts without it: BSC payouts wait (with a
  // review note) until it is set. Address only.
  platformBscAddress: readOptionalEthAddress(
    "PLATFORM_BSC_ADDRESS",
    process.env.PLATFORM_BSC_ADDRESS,
  ),

  // The gas wallets that top up a token deposit before its payout, one per
  // EVM chain. Sealed with DATA_ENCRYPTION_KEY; create one with
  // `npx tsx src/scripts/create-evm-gas-wallet.ts eth|bsc`. Optional: token
  // payouts wait (with a review note) until it is set.
  ethGasWalletKey: readOptionalSealedSecret(
    "ETH_GAS_WALLET_KEY",
    process.env.ETH_GAS_WALLET_KEY,
  ),
  bscGasWalletKey: readOptionalSealedSecret(
    "BSC_GAS_WALLET_KEY",
    process.env.BSC_GAS_WALLET_KEY,
  ),

  platformLtcAddress: readLtcAddress(
    "PLATFORM_LTC_ADDRESS",
    process.env.PLATFORM_LTC_ADDRESS,
  ),

  // Receives the platform fee for SOL, USDT and USDC on Solana.
  // Address only: this wallet's key never goes on the server.
  platformSolAddress: readSolAddress(
    "PLATFORM_SOL_ADDRESS",
    process.env.PLATFORM_SOL_ADDRESS,
  ),

  // The Solana gas wallet: a hot wallet that pays fees for USDT/USDC payouts.
  // Sealed with DATA_ENCRYPTION_KEY. Create it with
  // `npx tsx src/scripts/create-sol-gas-wallet.ts`.
  // Optional because that script itself needs this file to load; token
  // payouts wait (with a warning) until it is set.
  solGasWalletKey: readOptionalSealedSecret(
    "SOL_GAS_WALLET_KEY",
    process.env.SOL_GAS_WALLET_KEY,
  ),

  // Receives the TON platform fee and NEAR refunds of TON swaps.
  // Address only: this wallet's key never goes on the server.
  platformTonAddress: readTonAddress(
    "PLATFORM_TON_ADDRESS",
    process.env.PLATFORM_TON_ADDRESS,
  ),

  nearIntentsJwt: readRequiredString("NEAR_INTENTS", process.env.NEAR_INTENTS),
});

function readRequiredString(name: string, value: string | undefined): string {
  const normaliseValue = value?.trim();

  if (!normaliseValue) {
    throw new Error(`${name} is required`);
  }

  return normaliseValue;
}

function readEthAddress(name: string, value: string | undefined): string {
  const address = readRequiredString(name, value);
  if (!isAddress(address)) {
    throw new Error(`${name} must be a valid Ethereum address`);
  }
  return getAddress(address);   // store it checksummed
}

function readOptionalEthAddress(name: string, value: string | undefined): string | undefined {
  return value?.trim() ? readEthAddress(name, value) : undefined;
}

function readLtcAddress(name: string, value: string | undefined): string {
  const address = readRequiredString(name, value);
  // Same rule as isValidLtcAddress in transactions/ltc.ts (that module
  // imports env, so env can't import it back).
  if (!litecore.Address.isValid(address, litecore.Networks.livenet)) {
    throw new Error(`${name} must be a valid mainnet Litecoin address`);
  }
  return address;
}

function readSolAddress(name: string, value: string | undefined): string {
  const address = readRequiredString(name, value);
  // Base58 text that decodes to exactly 32 bytes.
  if (!isSolAddress(address)) {
    throw new Error(`${name} must be a valid Solana address`);
  }
  return address;
}

function readTonAddress(name: string, value: string | undefined): string {
  const address = readRequiredString(name, value);
  // Same rule as isValidTonAddress in transactions/ton.ts (that module
  // imports env, so env can't import it back). Only the EQ…/UQ… form: it
  // has a checksum, so a typo is caught. The raw "0:…" form has none.
  let parsed: ReturnType<typeof TonAddress.parseFriendly>;
  try {
    parsed = TonAddress.parseFriendly(address);
  } catch {
    throw new Error(`${name} must be a valid TON address (EQ… or UQ…)`);
  }
  if (parsed.isTestOnly || parsed.address.workChain !== 0) {
    throw new Error(`${name} must be a mainnet TON address on workchain 0`);
  }
  return address;
}

// Format: "<keyVersion>.<iv>.<authTag>.<ciphertext>", each part base64.
// formatSealedSecretForEnv in crypto/sol.ts writes it.
function readOptionalSealedSecret(
  name: string,
  value: string | undefined,
): SealedSecret | undefined {
  const text = value?.trim();
  if (!text) return undefined;

  const parts = text.split(".");
  if (parts.length !== 4 || !/^[1-9][0-9]*$/.test(parts[0])) {
    throw new Error(`${name} must look like "1.<iv>.<tag>.<ciphertext>"`);
  }

  const [initialisationVector, authenticationTag, ciphertext] = parts
    .slice(1)
    .map((part) => {
      const bytes = Buffer.from(part, "base64");
      if (bytes.length === 0 || bytes.toString("base64") !== part) {
        throw new Error(`${name} has a part that is not valid base64`);
      }
      return bytes;
    });

  // AES-256-GCM: 12-byte IV and 16-byte tag (see secret-envelope.ts).
  if (initialisationVector.length !== 12 || authenticationTag.length !== 16) {
    throw new Error(`${name} has the wrong IV or tag length`);
  }

  return {
    keyVersion: Number(parts[0]),
    initialisationVector,
    authenticationTag,
    ciphertext,
  };
}

function readBase64Key(name: string, value: string | undefined): Buffer {
  const encodedKey = readRequiredString(name, value);

  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error(`${name} must be a valid base64-encode 32-byte key`);
  }

  return key;
}
