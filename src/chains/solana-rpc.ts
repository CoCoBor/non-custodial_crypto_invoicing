import { createEvmRpc } from "./evm-rpc.js";

/**
 * A Solana JSON-RPC endpoint: NOWNodes in production, a local
 * solana-test-validator in tests. `call` answers the `result` of the reply,
 * or undefined when the call failed or the node answered with an error
 * (already logged). A `null` result (e.g. no such account) is returned as null.
 */
export type SolanaRpc = {
  call: (method: string, params: unknown[]) => Promise<unknown>;
};

// Same JSON-RPC 2.0 envelope, api-key header and no-redirect rule as the EVM client.
export function createSolanaRpc(options: {
  url: string;
  /** Sends the NOWNodes api-key header. Off for a local node. */
  sendApiKey?: boolean;
  fetcher?: typeof fetch;
}): SolanaRpc {
  return createEvmRpc({ ...options, label: "SOL" });
}

export const nowNodesSolRpc = createSolanaRpc({ url: "https://sol.nownodes.io" });
