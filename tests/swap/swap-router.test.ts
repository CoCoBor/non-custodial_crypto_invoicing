import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssetId } from "../../src/assets/payout-address.js";
import { createSwapRouter } from "../../src/swap/router.js";
import type { QuoteAnswer, SwapPort, SwapProvider, SwapRef, SwapRequest } from "../../src/swap/swap-port.js";

// The swap port the app and the watcher use: it hands each call to the
// provider that serves it. Quotes go to the provider whose supports(from, to)
// is true; status and start go to the provider stored with the swap.

type Calls = { supports: string[]; quotes: SwapRequest[]; statuses: SwapRef[]; starts: (SwapRef & { txid: string })[] };

function provider(name: SwapProvider, serves: (from: AssetId, to: AssetId) => boolean) {
  const calls: Calls = { supports: [], quotes: [], statuses: [], starts: [] };
  const port: SwapPort = {
    supports: (from, to) => {
      calls.supports.push(`${from}>${to}`);
      return serves(from, to);
    },
    quote: async (request): Promise<QuoteAnswer> => {
      calls.quotes.push(request);
      return {
        kind: "ok",
        quote: {
          provider: name,
          depositAddress: `${name}-deposit`,
          amountIn: request.amountIn,
          amountOut: 1n,
          minAmountOut: 1n,
          record: {},
        },
      };
    },
    start: async (swap) => {
      calls.starts.push(swap);
      return true;
    },
    status: async (swap) => {
      calls.statuses.push(swap);
      return { status: "PROCESSING", originTxids: [name], deliveryTxids: [] };
    },
  };
  return { port, calls };
}

function setUp() {
  const near = provider("near_intents", (from, to) => from !== to && from !== "xmr" && to !== "xmr");
  const exolix = provider("exolix", (from, to) => from !== to && (from === "xmr" || to === "xmr"));
  return { near, exolix, router: createSwapRouter({ near_intents: near.port, exolix: exolix.port }) };
}

const request = (from: AssetId, to: AssetId): SwapRequest => ({
  from,
  to,
  amountIn: 1_000n,
  recipient: "merchant",
  refundTo: "deposit",
  maxLossBps: 50,
});

describe("the swap router", () => {
  it("supports a pair when any provider does", () => {
    const { router } = setUp();
    assert.equal(router.supports("btc", "usdceth"), true);
    assert.equal(router.supports("xmr", "btc"), true);
    assert.equal(router.supports("btc", "xmr"), true);
    assert.equal(router.supports("btc", "btc"), false);
  });

  it("sends a quote for an XMR pair to Exolix only, and any other pair to NEAR only", async () => {
    const { router, near, exolix } = setUp();

    const toXmr = await router.quote(request("btc", "xmr"));
    const fromXmr = await router.quote(request("xmr", "usdttrx"));
    const plain = await router.quote(request("btc", "usdceth"));

    assert.equal(toXmr.kind === "ok" && toXmr.quote.provider, "exolix");
    assert.equal(fromXmr.kind === "ok" && fromXmr.quote.provider, "exolix");
    assert.equal(plain.kind === "ok" && plain.quote.provider, "near_intents");
    assert.deepEqual(exolix.calls.quotes.map((q) => `${q.from}>${q.to}`), ["btc>xmr", "xmr>usdttrx"]);
    assert.deepEqual(near.calls.quotes.map((q) => `${q.from}>${q.to}`), ["btc>usdceth"]);
  });

  it("answers unavailable for a pair no provider supports, asking none for a quote", async () => {
    const { router, near, exolix } = setUp();

    const answer = await router.quote(request("btc", "btc"));

    assert.equal(answer.kind, "unavailable");
    assert.equal(near.calls.quotes.length + exolix.calls.quotes.length, 0);
  });

  it("asks the provider stored with the swap for its status, passing its swap id", async () => {
    const { router, near, exolix } = setUp();

    const fromExolix = await router.status({ provider: "exolix", depositAddress: "x-deposit", swapId: "ab12" });
    const fromNear = await router.status({ provider: "near_intents", depositAddress: "n-deposit" });

    assert.deepEqual(fromExolix?.originTxids, ["exolix"]);
    assert.deepEqual(fromNear?.originTxids, ["near_intents"]);
    assert.deepEqual(exolix.calls.statuses, [{ provider: "exolix", depositAddress: "x-deposit", swapId: "ab12" }]);
    assert.deepEqual(near.calls.statuses, [{ provider: "near_intents", depositAddress: "n-deposit" }]);
  });

  it("asks NEAR about a swap saved with no provider (before ticket 24 every swap was NEAR's)", async () => {
    const { router, near, exolix } = setUp();

    await router.status({ provider: "", depositAddress: "old-deposit" });
    await router.start({ provider: "", depositAddress: "old-deposit", txid: "t1" });

    assert.deepEqual(near.calls.statuses, [{ provider: "", depositAddress: "old-deposit" }]);
    assert.deepEqual(near.calls.starts, [{ provider: "", depositAddress: "old-deposit", txid: "t1" }]);
    assert.equal(exolix.calls.statuses.length + exolix.calls.starts.length, 0);
  });

  it("gives the deposit hint to the swap's own provider only", async () => {
    const { router, near, exolix } = setUp();

    await router.start({ provider: "exolix", depositAddress: "x-deposit", swapId: "ab12", txid: "t2" });

    assert.deepEqual(exolix.calls.starts, [{ provider: "exolix", depositAddress: "x-deposit", swapId: "ab12", txid: "t2" }]);
    assert.equal(near.calls.starts.length, 0);
  });
});
