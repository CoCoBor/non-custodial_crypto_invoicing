import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import recordings from "../fixtures/exchanges/metadata.json" with { type: "json" };
import { getTickers } from "../../src/pricing/sources.js";

// Raw JSON text is intentional: JSON.parse + stringify would round Bitfinex
// prices before the production parser sees them. Expected values are fixed
// observations in metadata.json, not computed with the implementation.
const fixtures = recordings.map((r) => ({ ...r,
  raw: readFileSync(new URL(`../fixtures/exchanges/${r.source}.json`, import.meta.url), "utf8"),
}));
function fixture(source: string) {
  const result = fixtures.find((r) => r.source === source);
  assert.ok(result, `missing ${source} fixture`);
  return result;
}

async function readOnly(source: string, body = fixture(source).raw, status = 200,
  now = fixture(source).receivedAtMs) {
  const recording = fixture(source);
  const fetcher: typeof fetch = async (input) => {
    if (String(input) !== recording.url) throw new Error("source unavailable");
    return new Response(body, { status });
  };
  return getTickers("btc", "usdt", { fetcher, now: () => now });
}

// A mutation changes exactly one field; all other checks receive valid data.
function replace(raw: string, path: string[], value: unknown): string {
  const body: unknown = JSON.parse(raw);
  let parent: unknown = body;
  for (const key of path.slice(0, -1)) {
    assert.ok(parent !== null && typeof parent === "object");
    parent = Reflect.get(parent, key);
  }
  assert.ok(parent !== null && typeof parent === "object");
  Object.defineProperty(parent, path.at(-1)!, { value, enumerable: true, configurable: true, writable: true });
  return JSON.stringify(body);
}

for (const r of fixtures) {
  describe(`${r.source} recorded response`, () => {
    it("accepts real data and preserves the expected fields and units", async () => {
      assert.deepEqual(await readOnly(r.source), [r.expected]);
    });
    it("rejects HTTP failure even with a completely valid body", async () => {
      assert.deepEqual(await readOnly(r.source, r.raw, 503), []);
    });
    it("rejects malformed JSON", async () => {
      assert.deepEqual(await readOnly(r.source, "<html>bad gateway</html>"), []);
    });
    it("attaches a live abort signal and refuses redirects", async () => {
      let inspected = false;
      const fetcher: typeof fetch = async (input, init) => {
        if (String(input) !== r.url) throw new Error("source unavailable");
        inspected = true;
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        assert.equal(init.redirect, "error");
        assert.equal(new Headers(init.headers).get("accept"), "application/json");
        return new Response(r.raw);
      };
      // A swallowed assertion inside fetcher must also fail this outer check.
      assert.deepEqual(await getTickers("btc", "usdt", { fetcher, now: () => r.receivedAtMs }), [r.expected]);
      assert.equal(inspected, true);
    });
    if (r.expected.sourceTimestampMs !== null) {
      it("enforces both freshness boundaries using the vendor's time unit", async () => {
        const stamp = r.expected.sourceTimestampMs!;
        for (const [offset, count] of [[60000, 1], [60001, 0], [-5000, 1], [-5001, 0]])
          assert.equal((await readOnly(r.source, r.raw, 200, stamp + offset)).length, count);
      });
    } else {
      it("keeps missing source time null instead of manufacturing freshness", async () => {
        const [ticker] = await readOnly(r.source, r.raw, 200, r.receivedAtMs + 86400000);
        assert.ok(ticker);
        assert.equal(ticker.sourceTimestampMs, null);
      });
    }
  });
}

interface Contract {
  source: string;
  bid: string[];
  ask: string[];
  volume: string[];
  identity?: string[];
  error?: [string[], unknown];
  spot?: [string[], unknown];
  list?: string[];
}
const contracts: Contract[] = [
  ...["binance", "mexc"].map((source) => ({source, bid:["bidPrice"], ask:["askPrice"], volume:["volume"], identity:["symbol"]})),
  {source:"bybit", bid:["result","list","0","bid1Price"], ask:["result","list","0","ask1Price"], volume:["result","list","0","volume24h"], identity:["result","list","0","symbol"], error:[["retCode"],10001], spot:[["result","category"],"linear"], list:["result","list"]},
  {source:"okx", bid:["data","0","bidPx"], ask:["data","0","askPx"], volume:["data","0","vol24h"], identity:["data","0","instId"], error:[["code"],"50000"], spot:[["data","0","instType"],"SWAP"], list:["data"]},
  {source:"gate", bid:["0","highest_bid"], ask:["0","lowest_ask"], volume:["0","base_volume"], identity:["0","currency_pair"], list:[]},
  {source:"kucoin", bid:["data","buy"], ask:["data","sell"], volume:["data","vol"], identity:["data","symbol"], error:[["code"],"500000"]},
  {source:"cryptocom", bid:["result","data","0","b"], ask:["result","data","0","k"], volume:["result","data","0","v"], identity:["result","data","0","i"], error:[["code"],10001], list:["result","data"]},
  {source:"xt", bid:["result","0","bp"], ask:["result","0","ap"], volume:["result","0","q"], identity:["result","0","s"], error:[["rc"],1], list:["result"]},
  {source:"gemini", bid:["bid"], ask:["ask"], volume:["volume","BTC"]},
  {source:"bitfinex", bid:["0","1"], ask:["0","3"], volume:["0","8"], identity:["0","0"], list:[]},
];

for (const c of contracts) {
  const r = fixture(c.source);
  describe(`${c.source} invalid data`, () => {
    for (const field of ["bid", "ask", "volume"] as const) {
      it(`rejects invalid or missing ${field} independently`, async () => {
        for (const bad of ["0", "-1", "NaN", "1,000", null, undefined])
          assert.deepEqual(await readOnly(c.source, replace(r.raw, c[field], bad)), [], `${field}: ${String(bad)}`);
      });
    }
    it("rejects crossed quotes", async () => {
      assert.deepEqual(await readOnly(c.source, replace(r.raw, c.bid, "999999999999")), []);
    });
    if (c.identity) {
      it("rejects a different market even when its ticker is valid", async () => {
        assert.deepEqual(await readOnly(c.source, replace(r.raw, c.identity!, "ETH_OTHER")), []);
      });
    }
    for (const [label, change] of [["vendor error", c.error], ["non-spot category", c.spot]] as const) {
      if (change) it(`rejects ${label} alongside valid data`, async () => {
        assert.deepEqual(await readOnly(c.source, replace(r.raw, ...change)), []);
      });
    }
    if (c.list) {
      it("rejects zero or multiple returned tickers", async () => {
        let list: unknown = JSON.parse(r.raw);
        for (const key of c.list!) {
          assert.ok(list !== null && typeof list === "object");
          list = Reflect.get(list, key);
        }
        assert.ok(Array.isArray(list));
        for (const entries of [[], [list[0], list[0]]]) {
          const raw = c.list!.length ? replace(r.raw, c.list!, entries) : JSON.stringify(entries);
          assert.deepEqual(await readOnly(c.source, raw), []);
        }
      });
    }
  });
}

describe("all exchange sources together", () => {
  it("returns all twelve real responses in one request batch", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input); calls.push(url);
      const r = fixtures.find((f) => f.url === url);
      assert.ok(r, `unexpected URL ${url}`);
      return new Response(r.raw);
    };
    const now = Math.max(...fixtures.map((r) => r.receivedAtMs));
    const tickers = await getTickers("btc", "usdt", { fetcher, now: () => now });
    assert.deepEqual(calls.sort(), fixtures.map((r) => r.url).sort());
    assert.equal(tickers.length, 12);
    for (const r of fixtures)
      assert.deepEqual(tickers.find((t) => t.source === r.source), {...r.expected, receivedAtMs: now});
  });
  it("retains all eleven other sources when any one request fails", async () => {
    const now = Math.max(...fixtures.map((r) => r.receivedAtMs));
    for (const failed of fixtures) {
      const fetcher: typeof fetch = async (input) => {
        const r = fixtures.find((f) => f.url === String(input));
        assert.ok(r);
        if (r.source === failed.source) throw new Error("connection reset");
        return new Response(r.raw);
      };
      const tickers = await getTickers("btc", "usdt", { fetcher, now: () => now });
      assert.deepEqual(tickers.map((t) => t.source).sort(), fixtures.filter((r) => r !== failed).map((r) => r.source).sort());
    }
  });
  it("preserves Bitfinex numeric tokens beyond binary float precision", async () => {
    const raw = '[["tBTCUST",1.234567890123456789e-3,1,1.3e-3,1,0,0,0,123.4567890123456789,2,1]]';
    const [ticker] = await readOnly("bitfinex", raw);
    assert.ok(ticker);
    assert.equal(ticker.bid, "0.001234567890123456789");
    assert.equal(ticker.ask, "0.0013");
    assert.equal(ticker.volume, "123.4567890123456789");
  });
});

describe("requesting a different base asset", () => {
  const symbols: Record<string, string> = {
    binance:"ETHUSDT", mexc:"ETHUSDT", bybit:"ETHUSDT", okx:"ETH-USDT",
    gate:"ETH_USDT", kucoin:"ETH-USDT", cryptocom:"ETH_USDT", xt:"eth_usdt",
    gemini:"ethusdt", bitfinex:"tETHUST",
  };
  for (const c of contracts) {
    it(`${c.source} requests and labels ETH/USDT`, async () => {
      const r = fixture(c.source);
      const symbol = symbols[c.source];
      const expectedUrl = r.url.replace(r.expected.marketSymbol, symbol);
      let raw = r.raw;
      if (c.identity) raw = replace(raw, c.identity, symbol);
      // Gemini identifies base volume by the currency key, not a symbol field.
      if (c.source === "gemini") {
        raw = replace(raw, ["volume", "ETH"], "4321.123");
        raw = replace(raw, ["volume", "BTC"], undefined);
      }
      const calls: string[] = [];
      const fetcher: typeof fetch = async (input) => {
        const url = String(input);
        if (new URL(url).hostname !== new URL(r.url).hostname) throw new Error("source unavailable");
        calls.push(url);
        return new Response(raw);
      };
      const tickers = await getTickers("eth", "usdt", { fetcher, now: () => r.receivedAtMs });
      assert.deepEqual(calls, [expectedUrl]);
      assert.deepEqual(tickers, [{...r.expected, baseAsset:"eth", marketSymbol:symbol,
        volume: c.source === "gemini" ? "4321.123" : r.expected.volume}]);
    });
  }
});
