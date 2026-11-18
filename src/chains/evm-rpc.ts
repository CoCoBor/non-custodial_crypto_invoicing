import { z } from "zod";

import { env } from "../config/env.js";

/**
 * An EVM JSON-RPC endpoint: NOWNodes in production, a local anvil node in
 * tests. `call` answers the `result` of the reply, or undefined when the call
 * failed or the node answered with an error (already logged). A `null`
 * result (e.g. no receipt yet) is returned as null.
 */
export type EvmRpc = {
  call: (method: string, params: unknown[]) => Promise<unknown>;
};

export function createEvmRpc(options: {
  url: string;
  /** Names the chain in log lines, e.g. "ETH". */
  label: string;
  /** Sends the NOWNodes api-key header. Off for a local node. */
  sendApiKey?: boolean;
  /** Defaults to the global fetch, looked up at call time. */
  fetcher?: typeof fetch;
}): EvmRpc {
  const { url, label } = options;
  const sendApiKey = options.sendApiKey ?? true;

  return {
    async call(method, params) {
      const fetcher = options.fetcher ?? globalThis.fetch;
      try {
        const res = await fetcher(url, {
          method: "POST",
          headers: {
            ...(sendApiKey && { "api-key": env.nowNodesApiKey }),
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          // Signed transactions travel in params: never logged.
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(10_000),
          // A redirect would carry the api-key header to another host.
          redirect: "error",
        });

        if (!res.ok) {
          console.warn(`${label} RPC HTTP failed:`, method, res.status);
          return undefined;
        }

        const body: unknown = await res.json();
        const rpcError = z
          .object({ error: z.object({ code: z.number(), message: z.string() }) })
          .safeParse(body);
        if (rpcError.success) {
          console.warn(`${label} RPC error:`, method, rpcError.data.error.code, rpcError.data.error.message.slice(0, 300));
          return undefined;
        }

        const result = z.object({ result: z.unknown() }).safeParse(body);
        return result.success ? result.data.result : undefined;
      } catch (error) {
        console.warn(`${label} RPC request failed:`, method, error instanceof Error ? error.message : "unknown error");
        return undefined;
      }
    },
  };
}

export const nowNodesEthRpc = createEvmRpc({ url: "https://eth.nownodes.io/", label: "ETH" });
export const nowNodesBscRpc = createEvmRpc({ url: "https://bsc.nownodes.io/", label: "BSC" });
