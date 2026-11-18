import "dotenv/config";
import { isAddress as isSolAddress } from "@solana/kit";
import { Address as TonAddress } from "@ton/core";
import litecore from "bitcore-lib-ltc";
import { getAddress, isAddress } from "ethers";
import { isValidMoneroAddress } from "../chains/monero-address.js";
// Type only: importing the module itself would loop (secret-envelope imports env).
import { isValidTronAddress } from "../chains/tron-address.js";
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

  // The TON gas wallet: a hot W5 wallet that sends the TON a jetton (USDT)
  // payout needs to the deposit. Sealed with DATA_ENCRYPTION_KEY. Create it
  // with `npx tsx src/scripts/create-ton-gas-wallet.ts`. Optional: jetton
  // payouts wait (with a review note) until it is set.
  tonGasWalletKey: readOptionalSealedSecret(
    "TON_GAS_WALLET_KEY",
    process.env.TON_GAS_WALLET_KEY,
  ),

  // Receives the platform fee for USDT on Tron. Optional so the server
  // starts without it: Tron payouts wait (with a review note) until it is
  // set. Address only.
  platformTrxAddress: readOptionalTronAddress(
    "PLATFORM_TRX_ADDRESS",
    process.env.PLATFORM_TRX_ADDRESS,
  ),

  // The Tron gas wallet: a hot wallet that sends a USDT deposit the TRX its
  // payout burns. Sealed with DATA_ENCRYPTION_KEY. Create it with
  // `npx tsx src/scripts/create-tron-gas-wallet.ts`. Optional: USDT payouts
  // on Tron wait (with a review note) until it is set.
  trxGasWalletKey: readOptionalSealedSecret(
    "TRX_GAS_WALLET_KEY",
    process.env.TRX_GAS_WALLET_KEY,
  ),

  // XMR arrives in one platform wallet run by our own monero-wallet-rpc, a
  // subaddress per invoice (docs/domain.md, "Monero adapter"). All optional
  // so the server starts without them: without the wallet URL, XMR invoices
  // can't be created; without the platform address, XMR payouts wait (with a
  // review note). The login is the wallet's --rpc-login "user:password".
  moneroWalletRpcUrl: readOptionalRpcUrl(
    "MONERO_WALLET_RPC_URL",
    process.env.MONERO_WALLET_RPC_URL,
  ),
  moneroWalletRpcLogin: readOptionalLogin(
    "MONERO_WALLET_RPC_LOGIN",
    process.env.MONERO_WALLET_RPC_LOGIN,
  ),
  // A monerod the payer-pays estimate asks for today's fee per byte
  // (monero-wallet-rpc has no call for it). Without it, XMR payer-pays
  // invoices are refused.
  moneroDaemonRpcUrl: readOptionalRpcUrl(
    "MONERO_DAEMON_RPC_URL",
    process.env.MONERO_DAEMON_RPC_URL,
  ),
  platformXmrAddress: readOptionalMoneroAddress(
    "PLATFORM_XMR_ADDRESS",
    process.env.PLATFORM_XMR_ADDRESS,
  ),

  nearIntentsJwt: readRequiredString("NEAR_INTENTS", process.env.NEAR_INTENTS),

  // ExchangeRate-API's keyed plan, the first source of USD → fiat rates.
  // Optional: without it only the keyless currency-api is asked
  // (src/invoice/fx-rates.ts).
  exchangeRateApiKey: process.env.EXCHANGERATE_API_KEY?.trim() || undefined,
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

function readOptionalTronAddress(name: string, value: string | undefined): string | undefined {
  const address = value?.trim();
  if (!address) return undefined;
  if (!isValidTronAddress(address)) {
    throw new Error(`${name} must be a valid mainnet Tron address (T…)`);
  }
  return address;
}

function readOptionalMoneroAddress(name: string, value: string | undefined): string | undefined {
  const address = value?.trim();
  if (!address) return undefined;
  if (!isValidMoneroAddress(address)) {
    throw new Error(`${name} must be a mainnet Monero standard address (4…) or subaddress (8…)`);
  }
  return address;
}

// The value is never put in an error: a URL can carry credentials.
function readOptionalRpcUrl(name: string, value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a URL like http://127.0.0.1:18083`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain a user or password; use the LOGIN setting`);
  }
  if (url.pathname === "/") url.pathname = "/json_rpc";
  return url.toString();
}

function readOptionalLogin(
  name: string,
  value: string | undefined,
): { username: string; password: string } | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const colon = text.indexOf(":");
  if (colon <= 0 || colon === text.length - 1) {
    throw new Error(`${name} must look like "user:password"`);
  }
  return { username: text.slice(0, colon), password: text.slice(colon + 1) };
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
