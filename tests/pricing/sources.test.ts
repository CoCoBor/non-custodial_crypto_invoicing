import assert from "node:assert/strict";
import { describe, it } from "node:test";

import bitstampBtcUsd from "../fixtures/bitstamp/btcusd.json" with { type: "json" };
import krakenXbtUsd from "../fixtures/kraken/xxbtzusd.json" with { type: "json" };
import { getTickers, type ExchangeTicker } from "../../src/pricing/sources.js";

// Both fixtures are real responses, recorded on 2026-09-14:
//   tests/fixtures/bitstamp/btcusd.json   GET bitstamp.net/api/v2/ticker/btcusd/
//   tests/fixtures/kraken/xxbtzusd.json   GET api.kraken.com/0/public/Ticker?pair=XXBTZUSD
// Bitstamp stamps its ticker, so "now" is derived from that stamp. Kraken
// carries no timestamp at all, which several tests below lean on.
const BITSTAMP_STAMP_MS = Number(bitstampBtcUsd.timestamp) * 1000;
const FRESH_MS = BITSTAMP_STAMP_MS + 1_000;

const BITSTAMP_URL = "https://www.bitstamp.net/api/v2/ticker/btcusd/";
const KRAKEN_URL = "https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD";

type Reply = { body: unknown; status?: number } | Error;

/**
 * A fetcher that answers by url substring, so one test can hand each
 * exchange a different response. Unmatched urls are a test bug and throw.
 */
function fakeFetcher(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) {
      throw new Error(`test has no route for ${url}`);
    }
    const reply = routes[key];
    if (reply instanceof Error) {
      throw reply;
    }
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  };
  return { fetcher, calls };
}

const bothHealthy = () =>
  fakeFetcher({ bitstamp: { body: bitstampBtcUsd }, kraken: { body: krakenXbtUsd } });

/** The kraken fixture with its inner ticker fields replaced. */
function kraken(overrides: Record<string, unknown> = {}, key = "XXBTZUSD") {
  const inner = { ...krakenXbtUsd.result.XXBTZUSD, ...overrides };
  return { error: [], result: { [key]: inner } };
}

/** The bitstamp fixture with fields replaced. */
function bitstamp(overrides: Record<string, unknown> = {}) {
  return { ...bitstampBtcUsd, ...overrides };
}

function bySource(tickers: ExchangeTicker[]) {
  return Object.fromEntries(tickers.map((t) => [t.source, t]));
}

describe("getTickers with both sources healthy", () => {
  it("returns both healthy sources while other sources fail", async () => {
    const { fetcher } = bothHealthy();
    const tickers = await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS });

    assert.deepEqual(tickers.map((t) => t.source).sort(), ["bitstamp", "kraken"]);
  });

  it("passes the bitstamp strings through untouched", async () => {
    const { fetcher } = bothHealthy();
    const { bitstamp } = bySource(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }));

    assert.equal(bitstamp?.bid, "77672.35");
    assert.equal(bitstamp?.ask, "77672.36");
    assert.equal(bitstamp?.volume, "1344.84002329");
  });

  it("reads kraken's bid, ask and 24 hour volume out of their tuples", async () => {
    // b[0]/a[0] are the prices; v[0] is today's volume and v[1] the rolling
    // 24 hours, which is the window every other source reports.
    const { fetcher } = bothHealthy();
    const { kraken } = bySource(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }));

    assert.equal(kraken?.bid, "78469.10000");
    assert.equal(kraken?.ask, "78469.20000");
    assert.equal(kraken?.volume, "2388.51939092");
  });

  it("labels each ticker with its exchange and market code", async () => {
    const { fetcher } = bothHealthy();
    const { bitstamp, kraken } = bySource(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }));

    assert.equal(bitstamp?.marketSymbol, "btcusd");
    assert.equal(kraken?.marketSymbol, "XXBTZUSD");
    for (const t of [bitstamp, kraken]) {
      assert.equal(t?.baseAsset, "btc");
      assert.equal(t?.quoteAsset, "usd");
    }
  });

  it("converts bitstamp's unix seconds and records that kraken has no stamp", async () => {
    const { fetcher } = bothHealthy();
    const { bitstamp, kraken } = bySource(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }));

    assert.equal(bitstamp?.sourceTimestampMs, 1_789_371_150_000);
    assert.equal(kraken?.sourceTimestampMs, null);
  });

  it("stamps every ticker with the clock it was received on", async () => {
    const { fetcher } = bothHealthy();
    for (const t of await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS })) {
      assert.equal(t.receivedAtMs, FRESH_MS);
    }
  });
});

describe("getTickers when a source fails", () => {
  it("keeps the healthy source when the other request throws", async () => {
    const { fetcher } = fakeFetcher({
      bitstamp: { body: bitstampBtcUsd },
      kraken: new Error("ECONNRESET"),
    });
    const tickers = await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS });

    assert.deepEqual(tickers.map((t) => t.source), ["bitstamp"]);
  });

  it("keeps the healthy source when the other returns a non-2xx status", async () => {
    const { fetcher } = fakeFetcher({
      bitstamp: { body: "unavailable", status: 503 },
      kraken: { body: krakenXbtUsd },
    });
    const tickers = await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS });

    assert.deepEqual(tickers.map((t) => t.source), ["kraken"]);
  });

  it("drops a non-2xx response even when its body parses as a ticker", async () => {
    // A 503 from a cache or proxy can carry the last good body. The status
    // has to be checked on its own, not left to the json parse to fail.
    const { fetcher } = fakeFetcher({
      bitstamp: { body: bitstampBtcUsd, status: 503 },
      kraken: new Error("skip"),
    });

    assert.deepEqual(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }), []);
  });

  it("keeps the healthy source when the other returns non-json", async () => {
    const { fetcher } = fakeFetcher({
      bitstamp: { body: "<html>Bad Gateway</html>" },
      kraken: { body: krakenXbtUsd },
    });
    const tickers = await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS });

    assert.deepEqual(tickers.map((t) => t.source), ["kraken"]);
  });

  it("returns an empty list when every source fails, never throwing", async () => {
    const { fetcher } = fakeFetcher({
      bitstamp: new Error("timeout"),
      kraken: { body: "{}", status: 500 },
    });

    assert.deepEqual(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }), []);
  });
});

describe("getTickers and the market configuration", () => {
  it("requests the usdt markets, not the usd ones, for a usdt quote", async () => {
    const { fetcher, calls } = fakeFetcher({
      btcusdt: { body: bitstampBtcUsd },
      XBTUSDT: { body: kraken({}, "XBTUSDT") },
    });
    await getTickers("btc", "usdt", { fetcher, now: () => FRESH_MS });

    assert.deepEqual(calls.sort(), [
  "https://api-pub.bitfinex.com/v2/tickers?symbols=tBTCUST",
  "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&symbolStatus=TRADING",
  "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT",
  "https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=BTC_USDT",
  "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT",
  "https://api.gemini.com/v1/pubticker/btcusdt",
  "https://api.kraken.com/0/public/Ticker?pair=XBTUSDT",
  "https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT",
  "https://api.mexc.com/api/v3/ticker/24hr?symbol=BTCUSDT",
  "https://sapi.xt.com/v4/public/ticker?symbol=btc_usdt",
  "https://www.bitstamp.net/api/v2/ticker/btcusdt/",
  "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"
]);
  });

  it("labels tickers with the quote that was requested", async () => {
    const { fetcher } = fakeFetcher({
      btcusdt: { body: bitstampBtcUsd },
      XBTUSDT: { body: kraken({}, "XBTUSDT") },
    });
    for (const t of await getTickers("btc", "usdt", { fetcher, now: () => FRESH_MS })) {
      assert.equal(t.quoteAsset, "usdt");
    }
  });

  it("only requests the exchanges configured for that market", async () => {
    // DAI/USDT is Kraken-only in the current catalog.
    const { fetcher, calls } = fakeFetcher({ kraken: { body: kraken({}, "DAIUSDT") } });
    const tickers = await getTickers("dai", "usdt", { fetcher, now: () => FRESH_MS });
    assert.deepEqual(calls, ["https://api.kraken.com/0/public/Ticker?pair=DAIUSDT"]);
    assert.deepEqual(tickers.map((t) => t.source), ["kraken"]);
  });

  it("makes no request at all for a market that is not configured", async () => {
    const { fetcher, calls } = bothHealthy();

    assert.deepEqual(await getTickers("usdt", "usdt", { fetcher }), []);
    assert.deepEqual(await getTickers("btc", "eur", { fetcher }), []);
    assert.deepEqual(await getTickers("bitcoin", "usd", { fetcher }), []);
    assert.equal(calls.length, 0);
  });
});

describe("getTickers validating kraken", () => {
  const krakenOnly = (body: unknown) =>
    fakeFetcher({ bitstamp: new Error("skip"), kraken: { body } });

  it("drops a response whose error list is not empty", async () => {
    // Kraken signals a bad pair with 200 + error, not with a status code.
    const { fetcher } = krakenOnly({
      error: ["EQuery:Unknown asset pair"],
      result: {},
    });

    assert.deepEqual(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }), []);
  });

  it("drops a response with an error even when a ticker is attached", async () => {
    // The case above is also caught by the empty result. This one is not:
    // a non-empty error beside a well-formed ticker is refused only by the
    // error check itself.
    const { fetcher } = krakenOnly({
      error: ["EGeneral:Temporary lockout"],
      result: { XXBTZUSD: krakenXbtUsd.result.XXBTZUSD },
    });

    assert.deepEqual(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }), []);
  });

  it("drops a response keyed by a different market than was asked for", async () => {
    // The response key is kraken's canonical code, which differs from many
    // request aliases. Accepting any key would let XBT/USD answer for ETH.
    const { fetcher } = krakenOnly(kraken({}, "XETHZUSD"));

    assert.deepEqual(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }), []);
  });

  it("drops a response carrying more than one market", async () => {
    const { fetcher } = krakenOnly({
      error: [],
      result: { XXBTZUSD: krakenXbtUsd.result.XXBTZUSD, XETHZUSD: krakenXbtUsd.result.XXBTZUSD },
    });

    assert.deepEqual(await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }), []);
  });

  it("drops a response whose tuples are the wrong length", async () => {
    // A too-short v is also caught downstream (v[1] is undefined); the
    // too-long ones are only refused by the tuple length itself.
    for (const bad of [
      { v: ["1"] },
      { v: ["1", "1", "1"] },
      { a: ["1", "1"] },
      { a: ["1", "1", "1", "1"] },
      { b: ["1", "1", "1", "1"] },
    ]) {
      const { fetcher } = krakenOnly(kraken(bad));
      assert.deepEqual(
        await getTickers("btc", "usd", { fetcher, now: () => FRESH_MS }),
        [],
        `accepted ${JSON.stringify(bad)}`,
      );
    }
  });

  it("is never rejected for age, because kraken supplies no timestamp", async () => {
    const { fetcher } = krakenOnly(krakenXbtUsd);
    const farFuture = () => BITSTAMP_STAMP_MS + 365 * 24 * 3_600_000;

    assert.equal((await getTickers("btc", "usd", { fetcher, now: farFuture })).length, 1);
  });
});

describe("getTickers validating bitstamp", () => {
  const bitstampOnly = (body: unknown) =>
    fakeFetcher({ bitstamp: { body }, kraken: new Error("skip") });
  const count = async (body: unknown, nowMs = FRESH_MS) =>
    (await getTickers("btc", "usd", { fetcher: bitstampOnly(body).fetcher, now: () => nowMs })).length;

  it("accepts a ticker exactly 60 seconds old and rejects one older", async () => {
    assert.equal(await count(bitstampBtcUsd, BITSTAMP_STAMP_MS + 60_000), 1);
    assert.equal(await count(bitstampBtcUsd, BITSTAMP_STAMP_MS + 60_001), 0);
  });

  it("tolerates a clock 5 seconds behind and rejects one further behind", async () => {
    assert.equal(await count(bitstampBtcUsd, BITSTAMP_STAMP_MS - 5_000), 1);
    assert.equal(await count(bitstampBtcUsd, BITSTAMP_STAMP_MS - 5_001), 0);
  });

  it("drops a bid above the ask", async () => {
    assert.equal(await count(bitstamp({ bid: "77672.37" })), 0);
  });

  it("drops a zero bid, ask or volume", async () => {
    for (const field of ["bid", "ask", "volume"]) {
      assert.equal(await count(bitstamp({ [field]: "0" })), 0, `${field} of 0 was accepted`);
    }
  });

  it("drops anything but the spot market", async () => {
    assert.equal(await count(bitstamp({ market_type: "PERP" })), 0);
  });

  it("drops the all-markets array bitstamp returns for an unknown pair", async () => {
    assert.equal(await count([bitstampBtcUsd]), 0);
  });

  it("drops prices sent as numbers rather than strings", async () => {
    assert.equal(await count(bitstamp({ bid: 77672.35 })), 0);
  });

  it("drops a signed or malformed decimal", async () => {
    for (const bad of ["-1", "+1", "1e5", "1.", ".5", "1,000", " 1"]) {
      assert.equal(await count(bitstamp({ bid: bad })), 0, `bid "${bad}" was accepted`);
    }
  });

  it("drops a timestamp that is not a plain integer string", async () => {
    for (const bad of ["1789371150.5", "-1", "abc", "", 1789371150]) {
      assert.equal(await count(bitstamp({ timestamp: bad })), 0, `timestamp ${JSON.stringify(bad)} was accepted`);
    }
  });

  it("drops a response missing a required field", async () => {
    for (const field of ["bid", "ask", "volume", "timestamp", "market_type"] as const) {
      const { [field]: _dropped, ...rest } = bitstampBtcUsd;
      assert.equal(await count(rest), 0, `a response without ${field} was accepted`);
    }
  });
});

describe("getTickers and the clock", () => {
  it("reads the clock after each body has arrived, not before the request", async () => {
    // Fresh when the request goes out, 61 seconds old by the time the body
    // has been read. Sampling the clock up front would accept it.
    let clock = FRESH_MS;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (!url.includes("bitstamp")) throw new Error("skip");
      const response = new Response(JSON.stringify(bitstampBtcUsd), { status: 200 });
      const readBody = response.json.bind(response);
      response.json = async () => {
        clock += 60_000;
        return readBody();
      };
      return response;
    };

    assert.deepEqual(await getTickers("btc", "usd", { fetcher, now: () => clock }), []);
  });

  it("can be called without options", async () => {
    // Signature only: the self-pair is unconfigured; this must stay offline.
    assert.deepEqual(await getTickers("usdt", "usdt"), []);
  });
});
