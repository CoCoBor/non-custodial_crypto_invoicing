import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AbiCoder, getAddress, id, Wallet } from "ethers";

import type { BlockbookApi } from "../../../src/chains/blockbook.js";
import { createEvmRpc, type EvmRpc } from "../../../src/chains/evm-rpc.js";
import token from "./TestToken.runtime.json" with { type: "json" };

// A throwaway anvil node (Foundry) in Docker for the EVM payout tests. Never
// mainnet: anvil makes its own chain. Chain id 1 stands in for Ethereum and
// 56 for BNB Smart Chain. The base fee is 0, so eth_gasPrice stays at 1 gwei
// and a payout's network cost is known exactly.

const run = promisify(execFile);
const IMAGE = "ghcr.io/foundry-rs/foundry:v1.9.0";
export const NODE_GAS_PRICE = 1_000_000_000n;

export async function dockerUnavailable(): Promise<string | undefined> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
    return undefined;
  } catch {
    return "Docker is not available, so the anvil payout tests are skipped (they start their own node container)";
  }
}

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const abi = AbiCoder.defaultAbiCoder();
const calldata = (signature: string, types: string[], values: unknown[]) =>
  id(signature).slice(0, 10) + abi.encode(types, values).slice(2);

export type AnvilNode = Awaited<ReturnType<typeof startAnvil>>;

export async function startAnvil(name: "eth" | "bsc", chainId: number) {
  const container = `merchant-test-anvil-${name}`;
  // Left behind by a run that was killed before its cleanup.
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
  await run(
    "docker",
    [
      "run", "-d", "--rm", "--name", container, "-p", "127.0.0.1::8545", IMAGE,
      // The image's entrypoint is `sh -c`: the command is one string.
      `anvil --host 0.0.0.0 --chain-id ${chainId} --block-base-fee-per-gas 0`,
    ],
    { timeout: 300_000 },
  );
  const stop = async () => {
    await run("docker", ["stop", "--time", "1", container]).catch(() => undefined);
  };

  try {
    const { stdout } = await run("docker", ["port", container, "8545/tcp"]);
    const hostPort = /127\.0\.0\.1:(\d+)/.exec(stdout)?.[1];
    if (hostPort === undefined) throw new Error(`no host port for ${container}: ${stdout}`);
    const url = `http://127.0.0.1:${hostPort}`;

    // Test-side calls throw on any error; the adapter gets the real client.
    async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await response.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result as T;
    }

    const started = Date.now();
    for (;;) {
      try {
        await rpc("eth_chainId");
        break;
      } catch (error) {
        if (Date.now() - started > 60_000) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const funder = Wallet.createRandom();
    await rpc("anvil_setBalance", [funder.address, "0x" + (10n ** 24n).toString(16)]);

    async function send(from: { address: string; signTransaction: Wallet["signTransaction"] }, to: string, value: bigint, data = "0x"): Promise<string> {
      const nonce = BigInt(await rpc<string>("eth_getTransactionCount", [from.address, "pending"]));
      const raw = await from.signTransaction({
        type: 0, chainId, nonce: Number(nonce), gasPrice: 2n * NODE_GAS_PRICE, gasLimit: 200_000n, to, value, data,
      });
      const txid = await rpc<string>("eth_sendRawTransaction", [raw]);
      const receipt = await waitForReceipt(txid);
      if (receipt.status !== "0x1") throw new Error(`test transaction ${txid} reverted (receipt status ${receipt.status})`);
      return txid.toLowerCase();
    }

    // Automine can answer eth_sendRawTransaction before the block holding the
    // transaction is queryable: a busy machine saw no receipt for ~30 ms.
    async function waitForReceipt(txid: string): Promise<{ status: string }> {
      const started = Date.now();
      for (;;) {
        const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [txid]);
        if (receipt !== null) return receipt;
        if (Date.now() - started > 10_000) throw new Error(`test transaction ${txid} not mined within 10 s (no receipt)`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    const node = {
      url,
      rpc,
      stop,
      chainId,
      /** The backend's real JSON-RPC client, pointed at this node. */
      client: createEvmRpc({ url, label: `anvil-${name}`, sendApiKey: false }) as EvmRpc,

      async mine(blocks: number) {
        await rpc("anvil_mine", ["0x" + blocks.toString(16)]);
      },
      async blockNumber(): Promise<bigint> {
        // A raw call: ethers' provider caches the block number.
        return BigInt(await rpc<string>("eth_blockNumber"));
      },
      async balance(address: string): Promise<bigint> {
        return BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));
      },
      async nonce(address: string): Promise<bigint> {
        return BigInt(await rpc<string>("eth_getTransactionCount", [address, "latest"]));
      },
      async setBalance(address: string, wei: bigint) {
        await rpc("anvil_setBalance", [address, "0x" + wei.toString(16)]);
      },
      /** A payer sends native coin to `to`. Returns the txid. */
      async pay(to: string, wei: bigint): Promise<string> {
        return await send(funder, to, wei);
      },

      /** Puts the test token's code at `contract` (a real token address) and sets it up. */
      async installToken(contract: string, decimals: number, noReturn: boolean) {
        await rpc("anvil_setCode", [contract, token.deployedBytecode]);
        await send(funder, contract, 0n, calldata("setup(uint8,bool)", ["uint8", "bool"], [decimals, noReturn]));
      },
      async tokenBalance(contract: string, owner: string): Promise<bigint> {
        return BigInt(await rpc<string>("eth_call", [{ to: contract, data: calldata("balanceOf(address)", ["address"], [owner]) }, "latest"]));
      },
      /** A payer sends `units` of the token to `to` with a real transfer. Returns the txid. */
      async payToken(contract: string, to: string, units: bigint): Promise<string> {
        await send(funder, contract, 0n, calldata("mint(address,uint256)", ["address", "uint256"], [funder.address, units]));
        return await send(funder, contract, 0n, calldata("transfer(address,uint256)", ["address", "uint256"], [to, units]));
      },
      /** What `txid` cost its sender in gas, from its receipt. */
      async gasCost(txid: string): Promise<bigint> {
        const receipt = await rpc<{ gasUsed: string; effectiveGasPrice: string }>("eth_getTransactionReceipt", [txid]);
        return BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      },
      async isMined(txid: string): Promise<boolean> {
        return (await rpc("eth_getTransactionReceipt", [txid])) !== null;
      },
    };
    return node;
  } catch (error) {
    await stop();
    throw error;
  }
}

type RpcTx = { hash: string; from: string; to: string | null; value: string; nonce: string };
type RpcLog = { address: string; topics: string[]; data: string };

/**
 * A Blockbook `/address/{address}?details=txs` answered from the node's own
 * blocks and receipts, in the shapes of Blockbook's openapi.yaml (Tx,
 * TokenTransfer, EthereumSpecific). One page; anvil chains are short.
 */
export function blockbookShim(node: AnvilNode): BlockbookApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async post() {
      return undefined;
    },
    async get(path: string) {
      calls.push(path);
      const match = /^\/address\/(0x[0-9a-fA-F]{40})\?details=txs&page=(\d+)/.exec(path);
      if (!match) return undefined;
      const address = getAddress(match[1]!);
      const latest = await node.blockNumber();
      const transactions = [];
      for (let height = latest; height >= 0n; height -= 1n) {
        const block = await node.rpc<{ timestamp: string; transactions: RpcTx[] }>("eth_getBlockByNumber", ["0x" + height.toString(16), true]);
        for (const tx of block.transactions) {
          const receipt = await node.rpc<{ status: string; logs: RpcLog[] }>("eth_getTransactionReceipt", [tx.hash]);
          const tokenTransfers = receipt.logs
            .filter((log) => log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3)
            .map((log) => ({
              type: "ERC20",
              standard: "ERC20",
              from: getAddress("0x" + log.topics[1]!.slice(-40)),
              to: getAddress("0x" + log.topics[2]!.slice(-40)),
              contract: getAddress(log.address),
              decimals: 0,
              value: BigInt(log.data).toString(),
            }));
          const touches =
            getAddress(tx.from) === address ||
            (tx.to !== null && getAddress(tx.to) === address) ||
            tokenTransfers.some((t) => t.from === address || t.to === address);
          if (!touches) continue;
          transactions.push({
            txid: tx.hash,
            vin: [{ n: 0, addresses: [getAddress(tx.from)], isAddress: true }],
            vout: [{ value: BigInt(tx.value).toString(), n: 0, addresses: tx.to ? [getAddress(tx.to)] : [], isAddress: true }],
            blockHeight: Number(height),
            confirmations: Number(latest - height + 1n),
            blockTime: Number(BigInt(block.timestamp)),
            value: BigInt(tx.value).toString(),
            ...(tokenTransfers.length > 0 && { tokenTransfers }),
            ethereumSpecific: { status: receipt.status === "0x1" ? 1 : 0, nonce: Number(BigInt(tx.nonce)) },
          });
        }
      }
      return {
        page: 1,
        totalPages: 1,
        itemsOnPage: 100,
        address,
        balance: (await node.balance(address)).toString(),
        unconfirmedBalance: "0",
        unconfirmedTxs: 0,
        txs: transactions.length,
        nonTokenTxs: transactions.filter((t) => !("tokenTransfers" in t)).length,
        ...(transactions.length > 0 && { transactions }),
      };
    },
  };
}
