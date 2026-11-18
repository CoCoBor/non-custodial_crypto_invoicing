import { randomBytes } from "node:crypto";

import litecore from "bitcore-lib-ltc";

/**
 * Config that passes every check in src/config/env.ts without touching real
 * services or the real .env. DOTENV_CONFIG_PATH=/dev/null stops dotenv from
 * reading .env even if a test forgets the test guard.
 */
export function fakeAppEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    DOTENV_CONFIG_PATH: "/dev/null",
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://127.0.0.1:1/never-connected",
    MONGODB_DATABASE: "never_connected_test",
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ACCOUNT_LOOKUP_HMAC_KEY: randomBytes(32).toString("base64"),
    NOWNODES_API_KEY: "fake-nownodes-key",
    NEAR_INTENTS: "fake-near-jwt",
    EXOLIX_API_KEY: "fake-exolix-key",
    PLATFORM_BTC_ADDRESS: "bc1qfake",
    PLATFORM_ETH_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    PLATFORM_LTC_ADDRESS: new litecore.PrivateKey().toAddress().toString(),
    PLATFORM_SOL_ADDRESS: "11111111111111111111111111111111",
    PLATFORM_TON_ADDRESS: "UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_",
    ...overrides,
  };
}
