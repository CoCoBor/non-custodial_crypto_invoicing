import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { fakeAppEnv } from "../helpers/fake-env.js";

// The Monero settings in src/config/env.ts, loaded in a child process with
// fake config only (DOTENV_CONFIG_PATH=/dev/null: the real .env is never read).

const PRINT = `
const { env } = await import("./src/config/env.ts");
console.log(JSON.stringify({
  wallet: env.moneroWalletRpcUrl ?? null,
  login: env.moneroWalletRpcLogin ? env.moneroWalletRpcLogin.username : null,
  daemon: env.moneroDaemonRpcUrl ?? null,
  platform: env.platformXmrAddress ?? null,
}));`;

function loadEnv(overrides: Record<string, string>) {
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", PRINT], {
    env: { PATH: process.env.PATH ?? "", ...fakeAppEnv(overrides) },
    encoding: "utf8",
  });
  return { ok: run.status === 0, out: run.stdout.trim(), err: run.stderr };
}

const STANDARD = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const INTEGRATED = "4BxSHvcgTwu25WooY4BVmgdcKwZu5EksVZSZkDd6ooxSVVqQ4ubxXkhLF6hEqtw96i9cf3cVfLw8UWe95bdDKfRQeYtPwLm1Jiw7AKt2LY";

describe("Monero settings", () => {
  it("are all optional", () => {
    const loaded = loadEnv({});
    assert.ok(loaded.ok, loaded.err);
    assert.deepEqual(JSON.parse(loaded.out), { wallet: null, login: null, daemon: null, platform: null });
  });

  it("read the wallet and daemon URLs (adding /json_rpc), the login and the platform address", () => {
    const loaded = loadEnv({
      MONERO_WALLET_RPC_URL: "http://10.0.0.5:18083",
      MONERO_WALLET_RPC_LOGIN: "merchant:pa:ss",
      MONERO_DAEMON_RPC_URL: "https://node.example:18089/json_rpc",
      PLATFORM_XMR_ADDRESS: STANDARD,
    });
    assert.ok(loaded.ok, loaded.err);
    assert.deepEqual(JSON.parse(loaded.out), {
      wallet: "http://10.0.0.5:18083/json_rpc",
      login: "merchant",
      daemon: "https://node.example:18089/json_rpc",
      platform: STANDARD,
    });
  });

  it("refuse an integrated platform address, a URL with credentials in it, and a login without a password, never printing the secret", () => {
    for (const [overrides, message] of [
      [{ PLATFORM_XMR_ADDRESS: INTEGRATED }, /PLATFORM_XMR_ADDRESS/],
      [{ PLATFORM_XMR_ADDRESS: "9ujeXrjzf7bfeK3KZdCqnYaMwZVFuXemPU8Ubw335rj2FN1CdMiWNyFV3ksEfMFvRp9L9qum5UxkP5rN9aLcPxbH1au4WAB" }, /PLATFORM_XMR_ADDRESS/],
      [{ MONERO_WALLET_RPC_URL: "http://u:topsecret1@127.0.0.1:18083" }, /MONERO_WALLET_RPC_URL/],
      [{ MONERO_WALLET_RPC_URL: "ftp://127.0.0.1:18083" }, /MONERO_WALLET_RPC_URL/],
      [{ MONERO_WALLET_RPC_LOGIN: "topsecret1" }, /MONERO_WALLET_RPC_LOGIN/],
    ] as const) {
      const loaded = loadEnv(overrides);
      assert.equal(loaded.ok, false, JSON.stringify(overrides));
      assert.match(loaded.err, message);
      assert.doesNotMatch(loaded.err, /topsecret1/);
    }
  });
});
