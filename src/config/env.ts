import "dotenv/config";
import { getAddress, isAddress } from "ethers";


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

function readBase64Key(name: string, value: string | undefined): Buffer {
  const encodedKey = readRequiredString(name, value);

  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error(`${name} must be a valid base64-encode 32-byte key`);
  }

  return key;
}
