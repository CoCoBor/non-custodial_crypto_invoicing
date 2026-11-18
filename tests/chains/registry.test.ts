import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ASSET_IDS, checkPayoutAddress } from "../../src/assets/payout-address.js";
import { chainAdapters, depositAssets } from "../../src/chains/registry.js";
import cryptos from "../../src/storage/cryptos.json" with { type: "json" };

// Rules every adapter in the registry must keep. A new chain fails here
// until its registry line, asset facts and address rule agree.

describe("the chain registry", () => {
  for (const asset of depositAssets()) {
    const adapter = chainAdapters[asset]!;

    describe(asset, () => {
      it("is registered under the asset it serves", () => {
        assert.equal(adapter.asset, asset);
      });

      it("reads its confirmations from the coin list", () => {
        assert.equal(adapter.requiredConfirmations, cryptos[asset].required_confirmations);
      });

      it("has an address rule in payout-address.ts, and checks addresses with it", () => {
        assert.notEqual(checkPayoutAddress(asset, ""), "unsupported");
        assert.equal(adapter.isValidAddress(""), false);
      });

      it("can pay a deposit out in its own asset", () => {
        assert.equal(adapter.canPayOutAs(asset), true);
      });
    });
  }

  it("serves BTC, LTC, ETH with its tokens, SOL with its tokens, BNB, TON, USDT on TON and USDT on Tron deposits today", () => {
    assert.deepEqual(depositAssets(), ["btc", "ltc", "eth", "sol", "ton", "usdteth", "daieth", "usdceth", "usdtsol", "usdcsol", "bsc", "usdtton", "usdttrx"]);
  });

  it("offers no TRX deposit: TRX only pays Tron fees", () => {
    assert.equal(Object.keys(chainAdapters).includes("trx"), false);
  });

  it("leaves out the BEP-20 tokens until their contracts are checked", () => {
    for (const asset of ["usdtbsc", "usdcbsc", "daibsc"] as const) assert.equal(chainAdapters[asset], undefined, asset);
  });

  it("lists only assets from the coin list", () => {
    for (const asset of Object.keys(chainAdapters)) assert.ok((ASSET_IDS as string[]).includes(asset), asset);
  });
});
