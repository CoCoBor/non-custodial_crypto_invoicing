import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TronApi } from "../../../src/chains/tron-api.js";
import { estimateTronTokenNetworkCost } from "../../../src/transactions/tron.js";

// The charge rule of fix ticket F at a fake Tron API port: the simulated
// energy at its price (no headroom), the bandwidth only where the account's
// free allowance does not cover a whole transaction, and the activation.
// Mainnet's prices (read 2026-11-18): 100 sun per energy, 1,000 sun per byte,
// activation 0.1 + 1 TRX. At a price of 1 USDT per TRX, a token unit is a sun.

const PLATFORM = "TVzYu8aczxtWAF2JmcEZEUapsYqtUWDU1p";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ENERGY = 64_285n;
const ACTIVATION = 100_000n + 1_000_000n;

function fakeApi(freeNetLimit: number): TronApi {
  return {
    post: async (path) => {
      if (path === "/wallet/getchainparameters") {
        return {
          chainParameter: [
            { key: "getEnergyFee", value: 100 },
            { key: "getTransactionFee", value: 1_000 },
            { key: "getCreateAccountFee", value: 100_000 },
            { key: "getCreateNewAccountFeeInSystemContract", value: 1_000_000 },
            { key: "getFreeNetLimit", value: freeNetLimit },
          ],
        };
      }
      if (path === "/wallet/getnowblock") {
        return { blockID: "00".repeat(32), block_header: { raw_data: { number: 1000, timestamp: 1_763_000_000_000 } } };
      }
      if (path === "/wallet/triggerconstantcontract") return { result: { result: true }, energy_used: Number(ENERGY), constant_result: [""] };
      throw new Error(`fake api: unexpected ${path}`);
    },
  };
}

const estimate = (freeNetLimit: number) =>
  estimateTronTokenNetworkCost({
    api: fakeApi(freeNetLimit),
    token: { asset: "usdttrx", contract: USDT, decimals: 6 },
    platformAddress: PLATFORM,
    trxPrice: async () => "1",
  });

describe("Tron charge", () => {
  it("charges the energy at its price, no headroom, and no bandwidth the free allowance covers", async () => {
    assert.equal(await estimate(5_000), 2n * ENERGY * 100n + ACTIVATION);
  });

  it("burns a transaction's whole bandwidth when the allowance left can't cover it all", async () => {
    const free = await estimate(5_000);
    const oneFits = (await estimate(600))! - free!;
    const noneFits = (await estimate(0))! - free!;
    // Mainnet's 600 free bytes cover the first transfer only.
    assert.ok(oneFits > 200_000n && oneFits < 500_000n, `one transfer's bytes at 1,000 sun: ${oneFits}`);
    assert.equal(noneFits, 2n * oneFits);
  });
});
