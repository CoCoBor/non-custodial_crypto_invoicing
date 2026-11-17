import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import bitcore from "bitcore-lib";
import litecore from "bitcore-lib-ltc";

// A throwaway bitcoind or litecoind in regtest mode, in Docker, for the
// payout tests. Never mainnet: the node makes its own chain and coins.
//
// The backend only knows mainnet addresses, and a regtest node prints the
// same output scripts under other prefixes. Nothing here compares address
// text: every lookup goes by output script (`raw(<hex>)` descriptors), and
// the node is asked for its own spelling only when its wallet must pay one.

const run = promisify(execFile);

export type UtxoChain = "btc" | "ltc";

const NODES = {
  btc: {
    image: "btcpayserver/bitcoin:31.1",
    container: "merchant-test-btc-regtest",
    daemon: "bitcoind",
    rpcPort: 18443,
    lib: bitcore,
  },
  ltc: {
    image: "btcpayserver/litecoin:0.21.5.8",
    container: "merchant-test-ltc-regtest",
    daemon: "litecoind",
    rpcPort: 19443,
    lib: litecore as unknown as typeof bitcore,
  },
} as const;

/** Why these tests can't run here, or undefined when Docker answers. */
export async function dockerUnavailable(): Promise<string | undefined> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
    return undefined;
  } catch {
    return "Docker is not available, so the regtest payout tests are skipped (they start their own node container)";
  }
}

/** Exact base units from a node amount such as "0.00100000". */
export function coinsToBaseUnits(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new Error(`not a node amount: ${text}`);
  return BigInt(match[1]!) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0"));
}

export function baseUnitsToCoins(units: bigint): string {
  return `${units / 100_000_000n}.${(units % 100_000_000n).toString().padStart(8, "0")}`;
}

// The node prints amounts as JSON numbers with 8 decimals. Keeping their
// source text means no amount ever passes through a float.
function parseNodeJson(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && context?.source?.includes(".") ? context.source : value,
  );
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type RegtestNode = Awaited<ReturnType<typeof startRegtestNode>>;

export async function startRegtestNode(chain: UtxoChain) {
  const spec = NODES[chain];
  const lib = spec.lib;
  const livenet = lib.Networks.livenet;

  // Left behind by a run that was killed before its cleanup.
  await run("docker", ["rm", "-f", spec.container]).catch(() => undefined);

  const password = randomBytes(16).toString("hex");
  await run(
    "docker",
    [
      "run", "-d", "--rm",
      "--name", spec.container,
      "-p", `127.0.0.1::${spec.rpcPort}`,
      spec.image,
      spec.daemon,
      "-regtest",
      "-server=1",
      "-txindex=1",
      "-rpcbind=0.0.0.0",
      // Docker's port mapping makes the test process look non-local to the node.
      "-rpcallowip=0.0.0.0/0",
      "-rpcuser=merchanttest",
      `-rpcpassword=${password}`,
      `-rpcport=${spec.rpcPort}`,
      "-fallbackfee=0.0001",
      // Regtest relays non-standard transactions by default; mainnet doesn't.
      // Turned off so dust and standardness are judged as on mainnet.
      "-acceptnonstdtxn=0",
    ],
    { timeout: 300_000 },
  );

  const stop = async () => {
    await run("docker", ["stop", "--time", "2", spec.container]).catch(() => undefined);
  };

  try {
    const { stdout } = await run("docker", ["port", spec.container, `${spec.rpcPort}/tcp`]);
    const hostPort = /127\.0\.0\.1:(\d+)/.exec(stdout)?.[1];
    if (hostPort === undefined) throw new Error(`no host port for ${spec.container}: ${stdout}`);
    const rpcUrl = `http://127.0.0.1:${hostPort}`;
    const authorization = `Basic ${Buffer.from(`merchanttest:${password}`).toString("base64")}`;

    async function rpc<T = any>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
      const response = await fetch(wallet ? `${rpcUrl}/wallet/${wallet}` : rpcUrl, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "1.0", id: method, method, params }),
      });
      const text = await response.text();
      let body: { result?: T; error?: { code: number; message: string } | null };
      try {
        body = parseNodeJson(text) as typeof body;
      } catch {
        throw new RpcError(response.status, `${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
      }
      if (body.error) throw new RpcError(body.error.code, `${method}: ${body.error.message}`);
      return body.result as T;
    }

    const started = Date.now();
    for (;;) {
      try {
        await rpc("getblockchaininfo");
        break;
      } catch (error) {
        if (Date.now() - started > 60_000) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    await rpc("createwallet", ["funder"]);
    const funderAddress: string = await rpc("getnewaddress", [], "funder");
    // Coinbase outputs are spendable after 100 blocks.
    await rpc("generatetoaddress", [101, funderAddress]);

    const scriptHex = (mainnetAddress: string) =>
      lib.Script.fromAddress(new lib.Address(mainnetAddress, livenet)).toHex();

    return {
      chain,
      lib,
      rpc,
      stop,
      scriptHex,

      /** The mainnet spelling of an output script, or undefined for one with no address. */
      mainnetAddress(scriptHexText: string): string | undefined {
        try {
          // bitcore takes a network here (and answers false for no address); its types don't say so.
          const script = new lib.Script(scriptHexText) as unknown as { toAddress(network: unknown): { toString(): string } | false };
          const address = script.toAddress(livenet);
          return address ? address.toString() : undefined;
        } catch {
          return undefined;
        }
      },

      async mine(blocks = 1) {
        await rpc("generatetoaddress", [blocks, funderAddress]);
      },

      /** The funder wallet pays `units` to the output script of a mainnet address. Returns the txid. */
      async pay(mainnetAddress: string, units: bigint): Promise<string> {
        const decoded = await rpc<{ address?: string; addresses?: string[] }>("decodescript", [scriptHex(mainnetAddress)]);
        const nodeAddress = decoded.address ?? decoded.addresses?.[0];
        if (nodeAddress === undefined) throw new Error(`the node has no address for ${mainnetAddress}`);
        return await rpc<string>("sendtoaddress", [nodeAddress, baseUnitsToCoins(units)], "funder");
      },

      /** What the output script of `mainnetAddress` holds in confirmed, unspent outputs. */
      async balance(mainnetAddress: string): Promise<bigint> {
        const scan = await rpc<{ total_amount: string }>("scantxoutset", ["start", [`raw(${scriptHex(mainnetAddress)})`]]);
        return coinsToBaseUnits(scan.total_amount);
      },

      async mempool(): Promise<string[]> {
        return await rpc<string[]>("getrawmempool");
      },

      /** The fee a mempool transaction pays, as the node computes it. */
      async mempoolFee(txid: string): Promise<bigint> {
        const entry = await rpc<{ fees: { base: string } }>("getmempoolentry", [txid]);
        return coinsToBaseUnits(entry.fees.base);
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
