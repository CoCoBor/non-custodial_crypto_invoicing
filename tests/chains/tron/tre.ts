import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AbiCoder, SigningKey, Wallet } from "ethers";

import { evmFormOfTronAddress, tronAddressFromBytes, tronAddressFromEvm } from "../../../src/chains/tron-address.js";
import { createTronApi, createTronBlockbookIndex, type TronApi, type TronTokenIndex } from "../../../src/chains/tron-api.js";
import { signTronTx } from "../../../src/chains/tron-tx.js";
import token from "../evm/TestToken.runtime.json" with { type: "json" };

// A throwaway Tron node (TronBox Runtime Environment) in Docker for the
// Tron payout tests. Never mainnet: TRE makes its own chain with ten funded
// accounts. It produces a block only when a transaction arrives, and every
// block is solidified at once.
//
// The test token is the EVM tests' TestToken. TRE can't put code at an
// address, so it is deployed at a new address and the adapter is given it.

const run = promisify(execFile);
const IMAGE = "tronbox/tre:2.0.0";
const CONTAINER = "merchant-test-tron";
const abi = AbiCoder.defaultAbiCoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function dockerUnavailable(): Promise<string | undefined> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
    return undefined;
  } catch {
    return "Docker is not available, so the Tron payout tests are skipped (they start their own node container)";
  }
}

/** Wraps init code around the runtime code: copy it to memory and return it. */
function creationCode(runtime: string): string {
  const length = runtime.length / 2;
  const init = "61" + length.toString(16).padStart(4, "0") + "80" + "61000d" + "6000" + "39" + "6000" + "f3";
  return init + runtime;
}

export type TronNode = Awaited<ReturnType<typeof startTron>>;

export async function startTron() {
  // Left behind by a run that was killed before its cleanup.
  await run("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
  await run("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", "127.0.0.1::9090", IMAGE], { timeout: 300_000 });
  const stop = async () => {
    await run("docker", ["stop", "--time", "1", CONTAINER]).catch(() => undefined);
  };

  try {
    const { stdout } = await run("docker", ["port", CONTAINER, "9090/tcp"]);
    const hostPort = /127\.0\.0\.1:(\d+)/.exec(stdout)?.[1];
    if (hostPort === undefined) throw new Error(`no host port for ${CONTAINER}: ${stdout}`);
    const url = `http://127.0.0.1:${hostPort}`;

    // Test-side calls throw on any error; the adapter gets the real client.
    async function post<T = any>(path: string, body: unknown = {}): Promise<T> {
      const response = await fetch(url + path, { method: "POST", body: JSON.stringify(body) });
      const reply = (await response.json()) as T & { Error?: string };
      if (reply.Error !== undefined) throw new Error(`${path}: ${reply.Error}`);
      return reply;
    }

    // Ready once the dev accounts are funded; their keys are printed in the log.
    let keys: string[] = [];
    const started = Date.now();
    for (;;) {
      try {
        const { stdout: logs } = await run("docker", ["logs", CONTAINER]);
        keys = [...logs.matchAll(/^\(\d+\) ([0-9a-f]{64})$/gm)].map((m) => "0x" + m[1]);
        if (keys.length >= 10) {
          const account = await post("/wallet/getaccount", { address: tronAddressFromEvm(new Wallet(keys[0]!).address), visible: true });
          if ((account.balance ?? 0) > 0) break;
        }
      } catch {
        // not up yet
      }
      if (Date.now() - started > 90_000) throw new Error("the Tron node did not start");
      await sleep(500);
    }
    const accounts = keys.map((key) => ({ key, address: tronAddressFromEvm(new Wallet(key).address) }));
    const funder = accounts[0]!;
    let nextGasAccount = 1;

    async function head() {
      const block = await post("/wallet/getnowblock");
      return { number: BigInt(block.block_header.raw_data.number), blockId: block.blockID as string, timestamp: block.block_header.raw_data.timestamp as number };
    }

    /** Waits until `txid` is in a solidified block; returns its transaction info. */
    async function landed(txid: string): Promise<any> {
      for (let i = 0; i < 100; i += 1) {
        const info = await post("/walletsolidity/gettransactioninfobyid", { value: txid });
        if (info.blockNumber !== undefined) return info;
        await sleep(100);
      }
      throw new Error(`transaction ${txid} did not land`);
    }

    async function signAndSend(transaction: any, key: string): Promise<string> {
      const sig = new SigningKey(key).sign("0x" + transaction.txID);
      transaction.signature = [sig.r.slice(2) + sig.s.slice(2) + sig.v.toString(16)];
      const reply = await post("/wallet/broadcasttransaction", transaction);
      if (reply.result !== true) throw new Error(`broadcast refused: ${JSON.stringify(reply)}`);
      return transaction.txID;
    }

    async function call(from: { key: string; address: string }, contract: string, selector: string, types: string[], values: unknown[]) {
      const built = await post("/wallet/triggersmartcontract", {
        owner_address: from.address,
        contract_address: contract,
        function_selector: selector,
        parameter: abi.encode(types, values).slice(2),
        fee_limit: 1_000_000_000,
        visible: true,
      });
      const txid = await signAndSend(built.transaction, from.key);
      const info = await landed(txid);
      if (info.receipt?.result !== "SUCCESS") throw new Error(`${selector} failed: ${info.receipt?.result}`);
      return { txid, info };
    }

    const node = {
      url,
      stop,
      post,
      head,
      landed,
      /** The backend's real Tron client, pointed at this node. */
      api: createTronApi({ baseUrl: url, sendApiKey: false }) as TronApi,
      funder,

      /** A genesis account (10,000 TRX) no other test uses, e.g. for a gas wallet. */
      freshFundedAccount() {
        const account = accounts[nextGasAccount];
        nextGasAccount += 1;
        if (account === undefined) throw new Error("out of funded dev accounts");
        return account;
      },

      async trxBalance(address: string): Promise<bigint> {
        const account = await post("/wallet/getaccount", { address, visible: true });
        return BigInt(account.balance ?? 0);
      },
      async isActive(address: string): Promise<boolean> {
        return (await post("/wallet/getaccount", { address, visible: true })).address !== undefined;
      },
      async chainParameter(key: string): Promise<bigint> {
        const reply = await post("/wallet/getchainparameters");
        return BigInt(reply.chainParameter.find((p: { key: string }) => p.key === key)?.value ?? 0);
      },

      /** Sends TRX, signed locally; waits until it lands. */
      async sendTrx(from: { key: string; address: string }, to: string, amount: bigint): Promise<string> {
        const ref = await head();
        const now = Date.now();
        const signed = signTronTx({ kind: "trx", from: from.address, to, amount }, from.key, { ref, expiration: ref.timestamp + 60_000, now });
        const reply = await post("/wallet/broadcasthex", { transaction: signed.hex });
        if (reply.result !== true) throw new Error(`TRX transfer refused: ${JSON.stringify(reply)}`);
        await landed(signed.txid);
        return signed.txid;
      },
      /** Makes the node produce a block (it only does when a transaction arrives). */
      async tick() {
        await node.sendTrx(funder, accounts[9]!.address, 1n);
      },

      /** Deploys the test token (energy paid by the caller only, as for USDT callers). */
      async deployToken(decimals: number): Promise<string> {
        const built = await post("/wallet/deploycontract", {
          owner_address: funder.address,
          abi: "[]",
          bytecode: creationCode(token.deployedBytecode.slice(2)),
          fee_limit: 1_000_000_000,
          origin_energy_limit: 10_000_000,
          consume_user_resource_percent: 100,
          name: "TestToken",
          visible: true,
        });
        // deploycontract answers the unsigned transaction itself.
        await signAndSend(built, funder.key);
        await landed(built.txID);
        const contract = tronAddressFromBytes(Buffer.from(built.contract_address, "hex"));
        // Tron USDT's transfer returns false; the adapter reads Transfer logs, so this returns nothing.
        await call(funder, contract, "setup(uint8,bool)", ["uint8", "bool"], [decimals, true]);
        return contract;
      },
      async tokenBalance(contract: string, owner: string): Promise<bigint> {
        const reply = await post("/wallet/triggerconstantcontract", {
          owner_address: owner,
          contract_address: contract,
          function_selector: "balanceOf(address)",
          parameter: abi.encode(["address"], [evmFormOfTronAddress(owner)]).slice(2),
          visible: true,
        });
        return BigInt("0x" + reply.constant_result[0]);
      },
      /** A payer sends `units` of the token to `to` with a real transfer. Returns the txid. */
      async payToken(contract: string, to: string, units: bigint, from = funder): Promise<string> {
        await call(funder, contract, "mint(address,uint256)", ["address", "uint256"], [evmFormOfTronAddress(from.address), units]);
        const { txid } = await call(from, contract, "transfer(address,uint256)", ["address", "uint256"], [evmFormOfTronAddress(to), units]);
        return txid;
      },
      /** What `txid` burned (fee, sun) and its energy and bandwidth, from its transaction info. */
      async costOf(txid: string) {
        const info = await landed(txid);
        return {
          fee: BigInt(info.fee ?? 0),
          energy: BigInt(info.receipt?.energy_usage_total ?? 0),
          energyFee: BigInt(info.receipt?.energy_fee ?? 0),
          netFee: BigInt(info.receipt?.net_fee ?? 0),
          netUsage: BigInt(info.receipt?.net_usage ?? 0),
        };
      },
    };
    return node;
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * A Blockbook index answered from the node's own blocks, through the real
 * Blockbook index client: `details=txids` lists every transaction with a
 * Transfer log from or to the address, of any token contract (a fake token
 * included), newest first. Test-only: the reply shape follows Blockbook's
 * openapi, not a recorded NOWNodes reply.
 */
export function blockbookIndexShim(node: TronNode, options: { pageSize?: number } = {}): TronTokenIndex & { calls: string[] } {
  const calls: string[] = [];
  const byAddress = new Map<string, string[]>();
  let scanned = 0n;

  async function scan() {
    const top = (await node.head()).number;
    for (let n = scanned + 1n; n <= top; n += 1n) {
      const infos: any[] = await node.post("/wallet/gettransactioninfobyblocknum", { num: Number(n) });
      for (const info of Array.isArray(infos) ? infos : []) {
        for (const log of info.log ?? []) {
          if (log.topics?.length !== 3 || log.topics[0] !== "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
          for (const topic of [log.topics[1], log.topics[2]]) {
            const address = tronAddressFromBytes(Buffer.from("41" + topic.slice(-40), "hex"));
            const list = byAddress.get(address) ?? [];
            if (!list.includes(info.id)) list.unshift(info.id);
            byAddress.set(address, list);
          }
        }
      }
    }
    scanned = top;
  }

  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const match = /\/api\/v2\/address\/(T[1-9A-HJ-NP-Za-km-z]{33})$/.exec(url.pathname);
    if (!match || url.searchParams.get("details") !== "txids") return new Response("{}", { status: 400 });
    await scan();
    const all = byAddress.get(match[1]!) ?? [];
    const pageSize = options.pageSize ?? Number(url.searchParams.get("pageSize") ?? 1000);
    const page = Number(url.searchParams.get("page") ?? 1);
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const txids = all.slice((page - 1) * pageSize, page * pageSize);
    const body = { page, totalPages, itemsOnPage: pageSize, address: match[1], txs: all.length, ...(txids.length > 0 && { txids }) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const index = createTronBlockbookIndex({ baseUrl: "http://blockbook-shim/api/v2", sendApiKey: false, fetcher });
  return { calls, transferTxids: index.transferTxids };
}
