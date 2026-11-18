import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssetId } from "../../src/assets/payout-address.js";
import { getUsdToCrypto } from "../../src/invoice/price.function.js";
import { lockPrice } from "../../src/invoice/pricing.js";
import cryptos from "../../src/storage/cryptos.json" with { type: "json" };

// lockPrice for USD prices must give exactly what the USD-only conversion
// (getUsdToCrypto) gave before fiat currencies were added.

const noFx = async () => {
  throw new Error("USD needs no FX rate");
};

describe("USD-priced amounts", () => {
  const amounts = ["0.01", "1", "25", "99.99", "1234567.89"];
  const prices = ["0.9998123456", "1", "4.5", "100.25", "64512.1234567891"];
  const coins: AssetId[] = ["btc", "eth", "usdteth", "xmr", "ton"];

  it("are the same as the USD-only conversion for every amount, price and coin decimals tried", async () => {
    for (const amount of amounts) {
      for (const price of prices) {
        for (const coin of coins) {
          const before = getUsdToCrypto({
            fiatAmount: amount,
            fiatDecimals: 2,
            coinPrice: price,
            coinDecimals: cryptos[coin].decimal,
          });
          const now = await lockPrice({
            unit: "usd",
            priceUnits: before!.fiatUnits,
            coin,
            getPrice: async () => price,
            getUsdToFiat: noFx,
            now: 0,
          });
          assert.notEqual(now, "price_unavailable");
          assert.equal(now !== "price_unavailable" && now.amount, before!.paymentUnits, `${amount} USD in ${coin} at ${price}`);
        }
      }
    }
  });
});
