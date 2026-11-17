import { z } from "zod";

import { env } from "../config/env.js";
import type { ChainPayment } from "./adapter.js";

/**
 * A Blockbook (/api/v2) endpoint: NOWNodes in production, a regtest shim in
 * tests. Both calls answer the parsed JSON reply, or undefined when the call
 * failed (already logged).
 */
export type BlockbookApi = {
  get: (path: string) => Promise<unknown>;
  /** Only for /sendtx/. The body is a signed transaction: never logged. */
  post: (path: string, body: string) => Promise<unknown>;
};

export function createBlockbookApi(options: {
  baseUrl: string;
  /** Names the chain in log lines, e.g. "BTC". */
  label: string;
  /** Defaults to the global fetch, looked up at call time. */
  fetcher?: typeof fetch;
}): BlockbookApi {
  const { baseUrl, label } = options;

  async function call(method: "GET" | "POST", path: string, body?: string): Promise<unknown> {
    const fetcher = options.fetcher ?? globalThis.fetch;
    try {
      const res = await fetcher(`${baseUrl}${path}`, {
        method,
        headers: {
          "api-key": env.nowNodesApiKey,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "text/plain" }),
        },
        signal: AbortSignal.timeout(10_000),
        // A redirect would carry the api-key header to another host.
        redirect: "error",
        ...(body !== undefined && { body }),
      });

      if (!res.ok) {
        // e.g. 400 {"error":"-26: txn-mempool-conflict"}. Worth seeing, and safe to log.
        console.warn(`${label} Blockbook ${method} failed:`, path, res.status, (await res.text()).slice(0, 300));
        return undefined;
      }

      return await res.json();
    } catch (error) {
      console.warn(
        `${label} Blockbook ${method} failed:`,
        path,
        error instanceof Error ? error.message : "unknown error",
      );
      return undefined;
    }
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
  };
}

export const nowNodesBtcBlockbook = createBlockbookApi({
  baseUrl: "https://btcbook.nownodes.io/api/v2",
  label: "BTC",
});

export const nowNodesLtcBlockbook = createBlockbookApi({
  baseUrl: "https://ltcbook.nownodes.io/api/v2",
  label: "LTC",
});

const paymentsPageSchema = z
  .object({
    totalPages: z.number().int().nonnegative(),
    txs: z.number().int().nonnegative(),
    unconfirmedTxs: z.number().int().nonnegative(),

    transactions: z
      .array(
        z.object({
          txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
          confirmations: z.number().int().nonnegative(),
          // Unix seconds: the block's time, or for a mempool transaction the
          // time this Blockbook first saw it.
          blockTime: z.number().int().positive().optional(),

          vout: z.array(
            z.object({
              value: z.string().regex(/^[0-9]+$/),
              isAddress: z.boolean().optional(),
              addresses: z.array(z.string()).optional(),
            }),
          ),
        }),
      )
      .default([]),
  })
  .refine(
    (data) => data.transactions.length > 0 || (data.txs === 0 && data.unconfirmedTxs === 0),
    { message: "Transaction details are missing" },
  );

// A deposit address sees a handful of payments. A listing longer than this is
// more likely a broken or hostile reply than a real history.
const MAX_PAGES = 50;

/**
 * Every transaction that paid `address` (BTC or LTC), with what it paid
 * there. undefined when any page fails, so a partial list is never returned.
 */
export async function getBlockbookPayments(
  api: BlockbookApi,
  address: string,
): Promise<ChainPayment[] | undefined> {
  const payments: ChainPayment[] = [];
  const seenTxids = new Set<string>();
  let page = 1;

  for (;;) {
    const parsed = paymentsPageSchema.safeParse(
      await api.get(`/address/${encodeURIComponent(address)}?details=txs&page=${page}&pageSize=100`),
    );
    if (!parsed.success) return undefined;

    const data = parsed.data;
    if (data.totalPages > MAX_PAGES) {
      console.error("Blockbook payment listing is implausibly long", data.totalPages);
      return undefined;
    }

    for (const transaction of data.transactions) {
      const txid = transaction.txid.toLowerCase();
      // A new transaction can push older ones onto the next page.
      if (seenTxids.has(txid)) continue;
      seenTxids.add(txid);

      let receivedAmount = 0n;
      for (const output of transaction.vout) {
        if (output.isAddress && output.addresses?.includes(address)) {
          receivedAmount += BigInt(output.value);
        }
      }

      if (receivedAmount > 0n) {
        payments.push({
          txid,
          amount: receivedAmount,
          confirmations: transaction.confirmations,
          ...(transaction.blockTime !== undefined && { seenAt: transaction.blockTime * 1000 }),
        });
      }
    }

    if (page >= data.totalPages) return payments;
    page += 1;
  }
}
