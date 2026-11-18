import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EvmRpc } from "../../../src/chains/evm-rpc.js";
import { EVM_CHAINS } from "../../../src/chains/evm.js";
import cryptos from "../../../src/storage/cryptos.json" with { type: "json" };
import { estimateEvmNativeNetworkCost, estimateEvmTokenNetworkCost, PAYER_PAYS_TOKEN_TRANSFER_GAS } from "../../../src/transactions/evm.js";

// The price per gas a payout pays, from a fake JSON-RPC port (fix ticket F):
// the latest base fee with room for two blocks of its largest rise, plus the
// node's suggested tip, not 125% of everything. All bigint.

const GWEI = 1_000_000_000n;
const hex = (n: bigint) => "0x" + n.toString(16);

function fakeRpc(input: { gasPrice: bigint; block: { baseFeePerGas?: string } | null | undefined }): EvmRpc {
  return {
    call: async (method) => {
      if (method === "eth_gasPrice") return hex(input.gasPrice);
      if (method === "eth_getBlockByNumber") return input.block;
      throw new Error(`fake rpc: unexpected ${method}`);
    },
  };
}

const nativeCost = (rpc: EvmRpc, chain: "eth" | "bsc" = "eth") => estimateEvmNativeNetworkCost({ chain: EVM_CHAINS[chain], rpc });
/** The price per gas a payout would pay: a native estimate is two 21,000-gas transfers. */
const priceOf = async (rpc: EvmRpc, chain: "eth" | "bsc" = "eth") => {
  const cost = await nativeCost(rpc, chain);
  return cost === undefined ? undefined : cost / 42_000n;
};

describe("EVM gas price", () => {
  it("pays the base fee raised for two blocks, plus the suggested tip unraised", async () => {
    // Base 10 gwei, suggestion 12 gwei: a 2 gwei tip. 10 × 81/64 = 12.65625 gwei.
    assert.equal(await priceOf(fakeRpc({ gasPrice: 12n * GWEI, block: { baseFeePerGas: hex(10n * GWEI) } })), 12_656_250_000n + 2n * GWEI);
  });

  it("pays exactly the suggestion on a chain whose base fee is 0 (BNB Smart Chain)", async () => {
    assert.equal(await priceOf(fakeRpc({ gasPrice: 3n * GWEI, block: { baseFeePerGas: "0x0" } }), "bsc"), 3n * GWEI);
  });

  it("adds no tip when the suggestion is below the base fee", async () => {
    assert.equal(await priceOf(fakeRpc({ gasPrice: 9n * GWEI, block: { baseFeePerGas: hex(10n * GWEI) } })), 12_656_250_000n);
  });

  it("rounds the raised base fee up", async () => {
    assert.equal(await priceOf(fakeRpc({ gasPrice: 1n, block: { baseFeePerGas: "0x1" } })), 2n);
  });

  it("keeps 125% of the suggestion on a chain with no base fee", async () => {
    assert.equal(await priceOf(fakeRpc({ gasPrice: 4n * GWEI, block: {} })), 5n * GWEI);
  });

  it("has no price when the block can't be read", async () => {
    assert.equal(await nativeCost(fakeRpc({ gasPrice: GWEI, block: null })), undefined);
    assert.equal(await nativeCost(fakeRpc({ gasPrice: GWEI, block: undefined })), undefined);
  });

  it("has no price above the chain's sanity cap", async () => {
    const cap = EVM_CHAINS.eth.maxGasPrice;
    assert.equal(await nativeCost(fakeRpc({ gasPrice: cap, block: { baseFeePerGas: hex(cap) } })), undefined);
  });

  it("estimates a payer-pays token payout as two typical transfers and the top-up's own gas, in token units rounded up", async () => {
    const rpc = fakeRpc({ gasPrice: GWEI, block: { baseFeePerGas: "0x0" } });
    const token = { asset: "usdteth" as const, contract: cryptos.usdteth.contract_address, decimals: 6 };
    const prices: Record<string, string> = { eth: "3000", usdteth: "1" };

    const estimate = await estimateEvmTokenNetworkCost({ chain: EVM_CHAINS.eth, rpc, token, getPrice: async (asset) => prices[asset] });

    // 151,000 gas at 1 gwei = 0.000151 ETH = 0.453 USD = 453,000 units.
    assert.equal(PAYER_PAYS_TOKEN_TRANSFER_GAS * 2n + 21_000n, 151_000n);
    assert.equal(estimate, 453_000n);
  });
});
