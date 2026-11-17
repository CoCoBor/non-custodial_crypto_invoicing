import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { coinsToBaseUnits, RpcError, type RegtestNode } from "./node.js";

// A test-only stand-in for NOWNodes' Blockbook API (/api/v2), answered from a
// regtest node's RPC. It serves only the calls the BTC and LTC code makes, in
// the reply shapes that code parses:
//   GET  /utxo/{address}?confirmed=true
//   GET  /address/{address}?details=txs&page=N&pageSize=M
//   GET  /tx/{txid}
//   GET  /estimatefee/{blocks}
//   POST /sendtx/          (body: the signed transaction in hex)
// Addresses arrive in their mainnet spelling and are looked up by output
// script (see node.ts). The shapes were written from the code, not recorded
// from a real Blockbook, so this proves the node side, not Blockbook's format.

type IndexedTx = {
  txid: string;
  /** undefined: in the mempool. */
  height: number | undefined;
  /** Block time, or the time the node's mempool first saw it (unix seconds). */
  time: number;
  outputs: { n: number; units: bigint; script: string }[];
  /** Outpoints it spends, "txid:n". */
  spends: string[];
};

type NodeTx = {
  txid: string;
  vin: { txid?: string; vout?: number; coinbase?: string }[];
  vout: { n: number; value: string; scriptPubKey: { hex: string } }[];
};

export type BlockbookShim = Awaited<ReturnType<typeof startBlockbookShim>>;

export async function startBlockbookShim(node: RegtestNode) {
  const state = {
    /** What /estimatefee answers, in coins per 1000 bytes. Regtest has no estimate of its own. */
    feePerKb: "0.0001",
    /** Every body POSTed to /sendtx/, accepted or not. */
    sent: [] as string[],
  };

  const confirmed: IndexedTx[] = [];
  let indexedHeight = 0;

  function index(tx: NodeTx, height: number | undefined, time: number): IndexedTx {
    return {
      txid: tx.txid,
      height,
      time,
      outputs: tx.vout.map((o) => ({ n: o.n, units: coinsToBaseUnits(o.value), script: o.scriptPubKey.hex })),
      spends: tx.vin.filter((i) => i.txid !== undefined).map((i) => `${i.txid}:${i.vout}`),
    };
  }

  /** Every transaction on the chain and in the mempool, and the tip height. */
  async function allTransactions(): Promise<{ txs: IndexedTx[]; tip: number }> {
    const tip = await node.rpc<number>("getblockcount");
    for (let height = indexedHeight + 1; height <= tip; height++) {
      const hash = await node.rpc<string>("getblockhash", [height]);
      const block = await node.rpc<{ time: number; tx: NodeTx[] }>("getblock", [hash, 2]);
      for (const tx of block.tx) confirmed.push(index(tx, height, block.time));
      indexedHeight = height;
    }
    const pool = await node.rpc<Record<string, { time: number }>>("getrawmempool", [true]);
    const unconfirmed: IndexedTx[] = [];
    for (const [txid, entry] of Object.entries(pool)) {
      const tx = await node.rpc<NodeTx>("getrawtransaction", [txid, true]);
      unconfirmed.push(index(tx, undefined, entry.time));
    }
    return { txs: [...confirmed, ...unconfirmed], tip };
  }

  async function addressTransactions(address: string, url: URL) {
    const script = node.scriptHex(address);
    const { txs, tip } = await allTransactions();
    const scriptOf = new Map<string, string>();
    for (const tx of txs) for (const o of tx.outputs) scriptOf.set(`${tx.txid}:${o.n}`, o.script);

    const touching = txs
      .filter((tx) => tx.outputs.some((o) => o.script === script) || tx.spends.some((s) => scriptOf.get(s) === script))
      // Blockbook lists the newest first, mempool before blocks.
      .sort((a, b) => (b.height ?? Infinity) - (a.height ?? Infinity));

    const pageSize = Number(url.searchParams.get("pageSize") ?? 1000);
    const page = Number(url.searchParams.get("page") ?? 1);
    const totalPages = Math.max(1, Math.ceil(touching.length / pageSize));
    const onPage = touching.slice((page - 1) * pageSize, page * pageSize);

    return {
      page,
      totalPages,
      itemsOnPage: pageSize,
      address,
      txs: touching.filter((tx) => tx.height !== undefined).length,
      unconfirmedTxs: touching.filter((tx) => tx.height === undefined).length,
      ...(touching.length > 0 && {
        transactions: onPage.map((tx) => ({
          txid: tx.txid,
          blockHeight: tx.height ?? -1,
          confirmations: tx.height === undefined ? 0 : tip - tx.height + 1,
          blockTime: tx.time,
          vout: tx.outputs.map((o) => {
            const spelled = node.mainnetAddress(o.script);
            return {
              n: o.n,
              value: o.units.toString(),
              isAddress: spelled !== undefined,
              addresses: spelled === undefined ? [] : [spelled],
            };
          }),
        })),
      }),
    };
  }

  async function utxos(address: string, url: URL) {
    if (url.searchParams.get("confirmed") !== "true") {
      throw new ShimRefusal("the shim serves only ?confirmed=true, the form the backend uses");
    }
    // scantxoutset sees confirmed outputs only, which is what confirmed=true asks for.
    const scan = await node.rpc<{ height: number; unspents: { txid: string; vout: number; amount: string; height: number }[] }>(
      "scantxoutset",
      ["start", [`raw(${node.scriptHex(address)})`]],
    );
    return scan.unspents.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: coinsToBaseUnits(u.amount).toString(),
      height: u.height,
      confirmations: scan.height - u.height + 1,
    }));
  }

  async function transaction(txid: string) {
    const tx = await node.rpc<{ txid: string; confirmations?: number; blocktime?: number; hex: string }>(
      "getrawtransaction",
      [txid, true],
    );
    return { txid: tx.txid, confirmations: tx.confirmations ?? 0, blockTime: tx.blocktime, hex: tx.hex };
  }

  async function route(request: IncomingMessage, body: string): Promise<unknown> {
    const url = new URL(request.url ?? "/", "http://shim");
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const tail = (prefix: string) => decodeURIComponent(path.slice(prefix.length));

    if (request.method === "GET" && /^\/estimatefee\/\d+$/.test(path)) return { result: state.feePerKb };
    if (request.method === "GET" && path.startsWith("/utxo/")) return await utxos(tail("/utxo/"), url);
    if (request.method === "GET" && path.startsWith("/address/")) return await addressTransactions(tail("/address/"), url);
    if (request.method === "GET" && path.startsWith("/tx/")) return await transaction(tail("/tx/"));
    if (request.method === "POST" && path === "/sendtx/") {
      state.sent.push(body);
      return { result: await node.rpc<string>("sendrawtransaction", [body]) };
    }
    throw new ShimRefusal(`the shim does not serve ${request.method} ${path}`);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      reply(200, await route(request, body));
    } catch (error) {
      // Blockbook answers 400 {"error": "..."} for an unknown tx or a refused broadcast.
      if (error instanceof RpcError || error instanceof ShimRefusal) {
        reply(400, { error: error instanceof RpcError ? `${error.code}: ${error.message}` : error.message });
      } else {
        reply(500, { error: error instanceof Error ? error.message : "shim failure" });
      }
    }
  }

  const server = createServer((request, response) => void handle(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    state,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

class ShimRefusal extends Error {}
