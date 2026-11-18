import { z } from "zod";

import { env } from "../config/env.js";

/**
 * A Tron full node's HTTP API (`/wallet/*`, `/walletsolidity/*`): NOWNodes
 * in production, a local tronbox/tre node in tests. `post` answers the
 * parsed JSON reply, or undefined when the call failed (already logged). A
 * reply the node sends for "not found" (`{}`) is returned as is; java-tron
 * reports most errors as HTTP 200 with an `Error` field, which is returned
 * as undefined too.
 */
export type TronApi = {
  post: (path: string, body: unknown) => Promise<unknown>;
};

type ClientOptions = {
  baseUrl: string;
  /** Sends the NOWNodes api-key header. Off for a local node. */
  sendApiKey?: boolean;
  /** Defaults to the global fetch, looked up at call time. */
  fetcher?: typeof fetch;
};

async function fetchJson(options: ClientOptions, label: string, path: string, init: RequestInit): Promise<unknown> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  try {
    const res = await fetcher(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        ...((options.sendApiKey ?? true) && { "api-key": env.nowNodesApiKey }),
        Accept: "application/json",
        ...(init.body !== undefined && { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(10_000),
      // A redirect would carry the api-key header to another host.
      redirect: "error",
    });
    if (!res.ok) {
      console.warn(`${label} HTTP failed:`, path, res.status);
      return undefined;
    }
    return await res.json();
  } catch (error) {
    console.warn(`${label} request failed:`, path, error instanceof Error ? error.message : "unknown error");
    return undefined;
  }
}

export function createTronApi(options: ClientOptions): TronApi {
  return {
    async post(path, body) {
      // Signed transactions travel in the body: never logged.
      const reply = await fetchJson(options, "TRX node", path, { method: "POST", body: JSON.stringify(body) });
      const error = z.object({ Error: z.string() }).safeParse(reply);
      if (error.success) {
        console.warn("TRX node error:", path, error.data.Error.slice(0, 300));
        return undefined;
      }
      return reply;
    },
  };
}

// 📄 https://docs.nownodes.io/trx/ (full node and solidity node on one host).
export const nowNodesTronApi = createTronApi({ baseUrl: "https://trx.nownodes.io" });

/**
 * Lists the transactions that may have moved a TRC-20 token into or out of
 * an address. Only a hint: amounts are read from the full node's own
 * transaction info, never from the index. undefined: the lookup failed or
 * the list may be incomplete.
 */
export type TronTokenIndex = {
  transferTxids: (address: string, contract: string) => Promise<string[] | undefined>;
};

const txidSchema = z
  .string()
  .regex(/^(?:0x)?[0-9a-fA-F]{64}$/)
  .transform((txid) => txid.replace(/^0x/, "").toLowerCase());

// More pages than this is treated as a listing that may be incomplete.
const MAX_INDEX_PAGES = 10;

/** A Blockbook (/api/v2) index, `details=txids`: every transaction touching the address. */
export function createTronBlockbookIndex(options: ClientOptions): TronTokenIndex {
  const pageSchema = z.object({
    page: z.number().int().positive(),
    totalPages: z.number().int().nonnegative(),
    txids: z.array(txidSchema).optional(),
  });
  return {
    async transferTxids(address) {
      const txids: string[] = [];
      for (let page = 1; page <= MAX_INDEX_PAGES; page += 1) {
        const reply = await fetchJson(
          options,
          "TRX Blockbook",
          `/address/${encodeURIComponent(address)}?details=txids&pageSize=1000&page=${page}`,
          { method: "GET" },
        );
        const parsed = pageSchema.safeParse(reply);
        if (!parsed.success || parsed.data.page !== page) return undefined;
        txids.push(...(parsed.data.txids ?? []));
        if (page >= parsed.data.totalPages) return txids;
      }
      return undefined;
    },
  };
}

/** A TronGrid-style index: `/v1/accounts/{address}/transactions/trc20`, incoming only. */
export function createTronGridIndex(options: ClientOptions): TronTokenIndex {
  const pageSchema = z.object({
    success: z.literal(true),
    data: z.array(z.object({ transaction_id: txidSchema })),
    meta: z.object({ fingerprint: z.string().min(1).optional() }).optional(),
  });
  return {
    async transferTxids(address, contract) {
      const txids: string[] = [];
      let fingerprint: string | undefined;
      for (let page = 1; page <= MAX_INDEX_PAGES; page += 1) {
        const query = new URLSearchParams({ only_to: "true", limit: "200", contract_address: contract });
        if (fingerprint !== undefined) query.set("fingerprint", fingerprint);
        const reply = await fetchJson(
          options,
          "TRX index",
          `/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${query}`,
          { method: "GET" },
        );
        const parsed = pageSchema.safeParse(reply);
        if (!parsed.success) return undefined;
        txids.push(...parsed.data.data.map((item) => item.transaction_id));
        fingerprint = parsed.data.meta?.fingerprint;
        if (fingerprint === undefined) return txids;
      }
      return undefined;
    },
  };
}

// 📄 https://docs.nownodes.io/trx/ lists a TRX Blockbook at this host. ⚠️ That
// it lists TRC-20 transfers of an address is not confirmed (docs/domain.md,
// "Tron adapter"); the payment check refuses an incomplete list.
export const nowNodesTronIndex = createTronBlockbookIndex({ baseUrl: "https://trx-blockbook.nownodes.io/api/v2" });
