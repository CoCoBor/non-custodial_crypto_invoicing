import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import recordings from "../fixtures/exchanges/metadata.json" with { type: "json" };
import { getReferencePrice } from "../../src/pricing/reference-price.js";
import { calculateWeightedPrice } from "../../src/pricing/weighted-price.js";
import { quoteFromFiat } from "../../src/pricing/quote.js";

const NOW = 1_789_404_030_000;
const fixtures = recordings.map((r) => ({ ...r,
  raw: readFileSync(new URL(`../fixtures/exchanges/${r.source}.json`, import.meta.url), "utf8"),
}));

// Four independent vendors, deliberately unequal midpoints and base volumes.
function replies(stamp = NOW, bid?: string, ask?: string) {
  return {
    "api.binance.com": { symbol: "BTCUSDT", bidPrice: bid ?? "99", askPrice: ask ?? "101", volume: "1", closeTime: stamp },
    "api.bybit.com": { retCode: 0, time: stamp, result: { category: "spot", list: [
      { symbol: "BTCUSDT", bid1Price: bid ?? "109", ask1Price: ask ?? "111", volume24h: "2" },
    ] } },
    "www.okx.com": { code: "0", data: [
      { instType: "SPOT", instId: "BTC-USDT", bidPx: bid ?? "119", askPx: ask ?? "121", vol24h: "1", ts: String(stamp) },
    ] },
    "api.gateio.ws": [{ currency_pair: "BTC_USDT", highest_bid: bid ?? "129", lowest_ask: ask ?? "131", base_volume: "1" }],
  };
}
function fetcherFor(bodies: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const body = bodies[new URL(String(input)).hostname];
    if (body === undefined) throw new Error("unavailable");
    return new Response(JSON.stringify(body));
  };
}

describe("getReferencePrice", () => {
  it("turns four independent sources into the volume-weighted midpoint", async () => {
    const result = await getReferencePrice("btc", "usdt", { fetcher: fetcherFor(replies()), now: () => NOW });
    assert.ok(result);
    assert.equal(result.price, "114"); // (100 + 110*2 + 120 + 130) / 5
    assert.equal(result.baseAsset, "btc");
    assert.equal(result.quoteAsset, "usdt");
    assert.equal(result.calculatedAtMs, NOW);
    assert.deepEqual(result.tickers.map((t) => t.source).sort(), ["binance", "bybit", "gate", "okx"]);
    assert.equal(result.tickers.find((t) => t.source === "gate")?.sourceTimestampMs, null);
  });

  it("returns no price with only three independent sources", async () => {
    const { "api.gateio.ws": _gate, ...three } = replies();
    assert.equal(await getReferencePrice("btc", "usdt", { fetcher: fetcherFor(three), now: () => NOW }), undefined);
  });

  it("does not count a huge unverified volume as the fourth source", async () => {
    const { "api.gateio.ws": _gate, ...three } = replies();
    const bodies = {...three, "www.bitstamp.net": {
      bid:"999999", ask:"1000001", volume:"99999999999", timestamp:String(NOW / 1000), market_type:"SPOT",
    }};
    assert.equal(await getReferencePrice("btc", "usdt", { fetcher: fetcherFor(bodies), now: () => NOW }), undefined);
  });

  it("does not let an unverified fifth source change the price", async () => {
    const bodies = {...replies(), "www.bitstamp.net": {
      bid:"999999", ask:"1000001", volume:"99999999999", timestamp:String(NOW / 1000), market_type:"SPOT",
    }};
    const result = await getReferencePrice("btc", "usdt", { fetcher: fetcherFor(bodies), now: () => NOW });
    assert.equal(result?.price, "114");
    assert.equal(result?.tickers.length, 4);
  });

  it("rechecks source age after the batch even when receipt time is fresh", async () => {
    let calls = 0;
    const now = () => ++calls <= 4 ? NOW + 59000 : NOW + 61000;
    assert.equal(await getReferencePrice("btc", "usdt", { fetcher: fetcherFor(replies()), now }), undefined);
    assert.equal(calls, 5);
  });

  it("rejects old receipts even when vendor timestamps remain within the limit", async () => {
    let calls = 0;
    const now = () => ++calls <= 4 ? NOW : NOW + 61000;
    // At the final check vendor timestamps are exactly 60s old, receipts 61s.
    assert.equal(await getReferencePrice("btc", "usdt", { fetcher: fetcherFor(replies(NOW + 1000)), now }), undefined);
    assert.equal(calls, 5);
  });

  it("rejects a clock that moves back beyond the allowed skew during the batch", async () => {
    let calls = 0;
    assert.equal(await getReferencePrice("btc", "usdt", {
      fetcher: fetcherFor(replies()), now: () => ++calls <= 4 ? NOW : NOW - 5001,
    }), undefined);
  });

  it("keeps input precision instead of silently dropping fine-grained prices", async () => {
    const result = await getReferencePrice("btc", "usdt", {
      fetcher: fetcherFor(replies(NOW, "0.123456789012345678", "0.123456789012345680")), now: () => NOW,
    });
    assert.equal(result?.price, "0.123456789");
    assert.equal(result?.tickers.length, 4);
  });

  it("returns no usable price if final rounding produces zero", async () => {
    assert.equal(await getReferencePrice("btc", "usdt", {
      fetcher: fetcherFor(replies(NOW, "0.000000000001", "0.000000000003")), now: () => NOW,
    }), undefined);
  });

  it("rejects bad output scales before doing any requests", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; throw new Error("unexpected request"); };
    for (const priceDecimals of [-1, 37, 0.5, NaN, Infinity])
      await assert.rejects(getReferencePrice("btc", "usdt", {fetcher, priceDecimals}), RangeError);
    assert.equal(calls, 0);
  });

  it("rejects an invalid final clock", async () => {
    let calls = 0;
    await assert.rejects(getReferencePrice("btc", "usdt", {
      fetcher: fetcherFor(replies()), now: () => ++calls <= 4 ? NOW : NaN,
    }), /application clock/);
  });

  it("returns undefined when every source fails", async () => {
    assert.equal(await getReferencePrice("btc", "usdt", { fetcher: fetcherFor({}), now: () => NOW }), undefined);
  });

  it("keeps USD separate and never falls back to USDT", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      calls.push(String(input)); throw new Error("unavailable");
    };
    assert.equal(await getReferencePrice("btc", "usd", { fetcher, now: () => NOW }), undefined);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((url) => !url.toLowerCase().includes("usdt") && !url.includes("tBTCUST")));
  });

  it("does not access the network for an unsupported self-pair", async () => {
    assert.equal(await getReferencePrice("usdt", "usdt"), undefined);
  });

  it("weights the nine reviewed real responses and exposes only contributors", async () => {
    const fetcher: typeof fetch = async (input) => {
      const r = fixtures.find((f) => f.url === String(input));
      assert.ok(r); return new Response(r.raw);
    };
    const result = await getReferencePrice("btc", "usdt", {
      fetcher, now: () => Math.max(...fixtures.map((r) => r.receivedAtMs)),
    });
    assert.ok(result);
    // Independently calculated with Python Decimal, precision 150, ROUND_HALF_UP.
    assert.equal(result.price, "78666.6483148607");
    assert.deepEqual(result.tickers.map((t) => t.source).sort(),
      ["binance", "bybit", "cryptocom", "gate", "gemini", "kraken", "kucoin", "mexc", "okx"]);
  });

  it("produces a USD price that quoteFromFiat can consume directly", async () => {
    // Use the same four-vendor contract with USD symbols; MEXC/KuCoin are absent.
    const bodies = JSON.parse(JSON.stringify(replies()).replaceAll("BTCUSDT", "BTCUSD")
      .replaceAll("BTC-USDT", "BTC-USD").replaceAll("BTC_USDT", "BTC_USD"));
    const reference = await getReferencePrice("btc", "usd", { fetcher: fetcherFor(bodies), now: () => NOW });
    assert.ok(reference);
    assert.deepEqual(quoteFromFiat({ fiatAmount:"10", currencyDecimals:2, price:reference.price, cryptoDecimals:8 }),
      { amountSmallestUnit:8771930, amountFiatMinorUnits:1000 });
  });
});

describe("rounding once after weighting", () => {
  it("does not round inputs or double-round the aggregate", () => {
    // Average 1.0049 rounds to 1.00. Rounding to 3dp first would give 1.005 -> 1.01.
    const tickers = ["1.004", "1.004", "1.0058", "1.0058"].map((price) => ({bid:price, ask:price, volume:"1"}));
    assert.equal(calculateWeightedPrice({ tickers, priceDecimals:4, volumeDecimals:0, outputDecimals:2 }), "1");
  });
  it("rounds a final half-unit upwards", () => {
    const tickers = Array.from({length:4}, () => ({bid:"1.005", ask:"1.005", volume:"1"}));
    assert.equal(calculateWeightedPrice({ tickers, priceDecimals:3, volumeDecimals:0, outputDecimals:2 }), "1.01");
  });
  it("validates the output scale even with no inputs", () => {
    for (const outputDecimals of [-1, 3, 0.5, NaN])
      assert.throws(() => calculateWeightedPrice({tickers:[], priceDecimals:2, volumeDecimals:0, outputDecimals}), RangeError);
  });
});
