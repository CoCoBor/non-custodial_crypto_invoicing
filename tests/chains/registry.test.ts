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

  it("serves BTC and TON deposits today", () => {
    assert.deepEqual(depositAssets(), ["btc", "ton"]);
  });

  it("lists only assets from the coin list", () => {
    for (const asset of Object.keys(chainAdapters)) assert.ok((ASSET_IDS as string[]).includes(asset), asset);
  });
});
