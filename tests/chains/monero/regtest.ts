import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { createMoneroRpc, type MoneroRpc } from "../../../src/chains/monero-rpc.js";

// A throwaway Monero regtest chain for the XMR adapter tests: monerod
// --regtest --offline at difficulty 1 (generateblocks mines instantly), and
// one monero-wallet-rpc per wallet. Never mainnet: the chain starts at
// genesis on this machine. monero-wallet-rpc has no --regtest, so its
// addresses use mainnet prefixes (4…, 8…), which the backend's address
// check accepts.

const INSTALL_HINT =
  "monerod / monero-wallet-rpc were not found, so the XMR regtest tests are skipped. " +
  "Download monero-mac-armv8-v0.18.5.4.tar.bz2 (or your platform's) from https://www.getmonero.org/downloads/, " +
  "check its sha256 against https://www.getmonero.org/downloads/hashes.txt, unpack it, " +
  "then set MONERO_BIN_DIR to the absolute path of the unpacked folder, or put both binaries on PATH.";

const BINARIES = ["monerod", "monero-wallet-rpc"] as const;

/** The folder holding monerod and monero-wallet-rpc: MONERO_BIN_DIR (absolute), else PATH. */
export function findMoneroBinDir(): string | undefined {
  const has = (dir: string) => BINARIES.every((name) => existsSync(join(dir, name)));
  const configured = process.env.MONERO_BIN_DIR?.trim();
  if (configured) return isAbsolute(configured) && has(configured) ? configured : undefined;
  return (process.env.PATH ?? "").split(delimiter).find((dir) => dir !== "" && has(dir));
}

export function moneroMissing(): string | undefined {
  const configured = process.env.MONERO_BIN_DIR?.trim();
  if (configured && findMoneroBinDir() === undefined) {
    return `MONERO_BIN_DIR is "${configured}", which is not an absolute path to a folder with both binaries. ${INSTALL_HINT}`;
  }
  return findMoneroBinDir() === undefined ? INSTALL_HINT : undefined;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const PLATFORM_LOGIN = { username: "merchant-test", password: "regtest-only-password" };

export type WalletName = "platform" | "miner" | "merchant" | "fee" | "refund";

export type MoneroRegtest = {
  daemon: MoneroRpc;
  wallets: Record<WalletName, MoneroRpc>;
  /** Each wallet's primary address. */
  addresses: Record<WalletName, string>;
  /** The platform wallet's JSON-RPC URL (it needs PLATFORM_LOGIN). */
  platformUrl: string;
  /** Mines blocks to the miner, then refreshes every wallet. */
  mine: (blocks: number) => Promise<void>;
  /** The miner pays `amount` piconero to each address in one transaction; returns its txid. */
  pay: (destinations: { address: string; amount: bigint }[]) => Promise<string>;
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
};

/** Calls a wallet or daemon method and returns its result, or throws. */
export async function must<T = Record<string, unknown>>(rpc: MoneroRpc, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const answer = await rpc.call(method, params);
  if (answer === undefined) throw new Error(`${method}: no reply`);
  if ("error" in answer) throw new Error(`${method}: ${answer.error.code} ${answer.error.message}`);
  return answer.result as T;
}

export async function startMoneroRegtest(binDir: string): Promise<MoneroRegtest> {
  // monerod's and the wallets' paths stay short and contain no spaces.
  const base = tmpdir().length > 40 ? "/tmp" : tmpdir();
  const dir = await mkdtemp(join(base, "mxmr-"));
  const processes: ChildProcess[] = [];
  const run = (name: string, args: string[]) => {
    const child = spawn(join(binDir, name), args, { stdio: "ignore" });
    processes.push(child);
    return child;
  };

  const stop = async () => {
    for (const child of processes) if (child.exitCode === null) child.kill("SIGTERM");
    for (let i = 0; i < 50 && processes.some((child) => child.exitCode === null && child.signalCode === null); i++) await sleep(100);
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  };

  try {
    const [rpcPort, p2pPort] = [await freePort(), await freePort()];
    run("monerod", [
      "--regtest", "--offline", "--fixed-difficulty", "1", "--non-interactive", "--no-zmq",
      "--data-dir", join(dir, "chain"), "--log-file", join(dir, "monerod.log"),
      "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", String(rpcPort),
      "--p2p-bind-ip", "127.0.0.1", "--p2p-bind-port", String(p2pPort),
    ]);
    const daemon = createMoneroRpc({ url: `http://127.0.0.1:${rpcPort}/json_rpc`, label: "regtest monerod", timeoutMs: 30_000 });
    await waitFor(daemon);

    const names: WalletName[] = ["platform", "miner", "merchant", "fee", "refund"];
    const urls = {} as Record<WalletName, string>;
    const wallets = {} as Record<WalletName, MoneroRpc>;
    for (const name of names) {
      const port = await freePort();
      run("monero-wallet-rpc", [
        "--daemon-address", `127.0.0.1:${rpcPort}`, "--trusted-daemon",
        // The wallet build is the same release as monerod, but regtest
        // starts at the newest hard fork from block 1, which the wallet
        // otherwise refuses.
        "--allow-mismatched-daemon-version", "--non-interactive",
        "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", String(port),
        "--wallet-dir", join(dir, `wallet-${name}`), "--log-file", join(dir, `wallet-${name}.log`),
        ...(name === "platform" ? ["--rpc-login", `${PLATFORM_LOGIN.username}:${PLATFORM_LOGIN.password}`] : ["--disable-rpc-login"]),
      ]);
      urls[name] = `http://127.0.0.1:${port}/json_rpc`;
      wallets[name] = createMoneroRpc({
        url: urls[name],
        label: `regtest wallet ${name}`,
        ...(name === "platform" && { login: PLATFORM_LOGIN }),
      });
    }
    await Promise.all(names.map((name) => waitFor(wallets[name])));

    const addresses = {} as Record<WalletName, string>;
    for (const name of names) {
      await must(wallets[name], "create_wallet", { filename: name, language: "English" });
      addresses[name] = (await must<{ address: string }>(wallets[name], "get_address", { account_index: 0 })).address;
    }

    const refresh = async () => {
      await Promise.all(names.map((name) => must(wallets[name], "refresh")));
    };
    const mine = async (blocks: number) => {
      await must(daemon, "generateblocks", { amount_of_blocks: blocks, wallet_address: addresses.miner });
      await refresh();
    };
    const pay = async (destinations: { address: string; amount: bigint }[]) => {
      const sent = await must<{ tx_hash: string }>(wallets.miner, "transfer", { destinations, priority: 1 });
      await refresh();
      return sent.tx_hash;
    };

    return { daemon, wallets, addresses, platformUrl: urls.platform, mine, pay, refresh, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function waitFor(rpc: MoneroRpc) {
  for (let i = 0; i < 200; i++) {
    const answer = await rpc.call("get_version");
    if (answer !== undefined && "result" in answer) return;
    await sleep(100);
  }
  throw new Error("a Monero process did not start");
}
