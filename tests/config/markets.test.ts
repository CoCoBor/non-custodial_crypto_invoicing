import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findMarkets,
  markets,
  parseMarketConfig,
} from "../../src/config/markets.js";

// The smallest config the schema should accept. Tests below break it one
// field at a time, so each failure names exactly the rule it exercises.
const minimal = { btc: { usd: { bitstamp: "btcusd" } } };

describe("parseMarketConfig", () => {
  it("accepts the config that ships with the service", () => {
    // `markets` is parsed at import, so reaching this line already proves the
    // shipped file is valid; the assertion pins that it is not empty.
    assert.ok(Object.keys(markets).length > 0);
  });

  it("accepts a single asset with a single quote and exchange", () => {
    assert.deepEqual(parseMarketConfig(minimal), minimal);
  });

  it("does not require every asset in the enum to be configured", () => {
    // A minimal deployment need not configure every supported asset.
    assert.doesNotThrow(() => parseMarketConfig(minimal));
  });

  it("rejects an empty config", () => {
    assert.throws(() => parseMarketConfig({}), /must not be empty/);
  });

  it("rejects an asset code that is not in the enum", () => {
    assert.throws(() => parseMarketConfig({ bitcoin: minimal.btc }));
  });

  it("rejects a quote currency that is not in the enum", () => {
    assert.throws(() =>
      parseMarketConfig({ btc: { eur: { bitstamp: "btceur" } } }),
    );
  });

  it("rejects a misspelled exchange name rather than ignoring it", () => {
    // Without .strict() zod would drop the unknown key silently, leaving an
    // asset that looks configured but has no source.
    assert.throws(() =>
      parseMarketConfig({ btc: { usd: { bitstmap: "btcusd" } } }),
    );
  });

  it("rejects an unknown key even when a valid exchange sits beside it", () => {
    // The case above is also caught by the "at least one exchange" rule once
    // the typo is dropped. This one is not: only .strict() refuses it, so it
    // is the test that keeps .strict() from being removed.
    assert.throws(() =>
      parseMarketConfig({
        btc: { usd: { bitstamp: "btcusd", bitstmap: "btcusd" } },
      }),
    );
  });

  it("rejects an asset with no quote currencies", () => {
    assert.throws(() => parseMarketConfig({ btc: {} }), /at least one quote/);
  });

  it("rejects a quote with no exchanges", () => {
    assert.throws(
      () => parseMarketConfig({ btc: { usd: {} } }),
      /at least one exchange/,
    );
  });

  it("rejects an uppercase bitstamp symbol", () => {
    // Bitstamp codes are lowercase; the url path is built from this verbatim.
    assert.throws(() =>
      parseMarketConfig({ btc: { usd: { bitstamp: "BTCUSD" } } }),
    );
  });

  it("rejects a bitstamp symbol that names a perpetual", () => {
    // Bitstamp lists derivatives as btcusd-perp alongside spot. Keeping the
    // dash out of the pattern means a perp cannot be configured by accident.
    assert.throws(() =>
      parseMarketConfig({ btc: { usd: { bitstamp: "btcusd-perp" } } }),
    );
  });

  it("accepts a market that only has kraken", () => {
    // The "at least one exchange" rule must count every exchange the schema
    // knows, not just the first one that was added.
    assert.doesNotThrow(() =>
      parseMarketConfig({ btc: { usd: { kraken: "XXBTZUSD" } } }),
    );
  });

  it("accepts a market with both exchanges", () => {
    assert.doesNotThrow(() =>
      parseMarketConfig({ btc: { usd: { bitstamp: "btcusd", kraken: "XXBTZUSD" } } }),
    );
  });

  it("rejects a lowercase kraken symbol", () => {
    // Kraken's codes are uppercase; the request is built from this verbatim
    // and the response is keyed by it, so case has to match exactly.
    assert.throws(() =>
      parseMarketConfig({ btc: { usd: { kraken: "xxbtzusd" } } }),
    );
  });

  it("rejects a kraken symbol with a separator", () => {
    assert.throws(() =>
      parseMarketConfig({ btc: { usd: { kraken: "XBT/USD" } } }),
    );
  });

  it("rejects a non-string symbol", () => {
    assert.throws(() => parseMarketConfig({ btc: { usd: { bitstamp: 1 } } }));
  });

  it("rejects an empty symbol", () => {
    assert.throws(() => parseMarketConfig({ btc: { usd: { bitstamp: "" } } }));
  });

  it("rejects input that is not an object at all", () => {
    for (const raw of [null, undefined, "btc", 42, []]) {
      assert.throws(() => parseMarketConfig(raw), `accepted ${String(raw)}`);
    }
  });

  it("reports the failure as a config error", () => {
    assert.throws(() => parseMarketConfig({}), /invalid market config/);
  });
});

describe("findMarkets", () => {
  it("returns every exchange configured for the pair", () => {
    assert.deepEqual(findMarkets("btc", "usd"), {
  "bitstamp": "btcusd",
  "kraken": "XXBTZUSD",
  "binance": "BTCUSD",
  "bybit": "BTCUSD",
  "okx": "BTC-USD",
  "gate": "BTC_USD",
  "cryptocom": "BTC_USD",
  "gemini": "btcusd",
  "bitfinex": "tBTCUSD"
});
  });

  it("returns only the exchanges that are configured", () => {
    assert.deepEqual(findMarkets("dai", "usdt"), { kraken: "DAIUSDT" });
  });

  it("keeps usd and usdt markets apart", () => {
    assert.equal(findMarkets("btc", "usdt")?.kraken, "XBTUSDT");
    assert.equal(findMarkets("btc", "usd")?.kraken, "XXBTZUSD");
  });

  it("returns undefined for a pair with no configuration", () => {
    assert.equal(findMarkets("usdt", "usdt"), undefined);
  });

  it("returns undefined for codes outside the enums", () => {
    assert.equal(findMarkets("bitcoin", "usd"), undefined);
    assert.equal(findMarkets("btc", "eur"), undefined);
    assert.equal(findMarkets("BTC", "usd"), undefined);
  });

  it("maps the product asset name to each vendor's own code", () => {
    // The product calls the asset "ton"; the vendor code happens to match
    // today, but nothing downstream may assume symbol = asset name.
    assert.equal(findMarkets("ton", "usd")?.bitstamp, "tonusd");
    // Kraken calls bitcoin XBT, so the two can never be the same string.
    assert.equal(findMarkets("btc", "usd")?.kraken, "XXBTZUSD");
  });

  it("is case sensitive on both the asset and the quote", () => {
    assert.equal(findMarkets("BTC", "usd"), undefined);
    assert.equal(findMarkets("btc", "USD"), undefined);
  });

  it("never throws on arbitrary strings", () => {
    // These come from callers that may have read them off a request; the
    // lookup answers "not configured", it does not crash.
    for (const bad of ["", " ", "btc ", "../btc", "btc\n", "__proto__"]) {
      assert.doesNotThrow(() => findMarkets(bad, "usd"));
      assert.equal(findMarkets(bad, "usd"), undefined, `accepted "${bad}"`);
      assert.doesNotThrow(() => findMarkets("btc", bad));
      assert.equal(findMarkets("btc", bad), undefined, `accepted quote "${bad}"`);
    }
  });
});

describe("exchange symbol formats", () => {
  const symbols = {
    bitstamp: "btcusdt", kraken: "XBTUSDT", binance: "BTCUSDT", mexc: "BTCUSDT",
    bybit: "BTCUSDT", okx: "BTC-USDT", gate: "BTC_USDT", kucoin: "BTC-USDT",
    cryptocom: "BTC_USDT", xt: "btc_usdt", gemini: "btcusdt", bitfinex: "tBTCUST",
  };
  for (const [exchange, symbol] of Object.entries(symbols)) {
    it(`accepts ${exchange} as the only source`, () => {
      const input = { btc: { usdt: { [exchange]: symbol } } };
      assert.deepEqual(parseMarketConfig(input), input);
    });
    it(`rejects invalid ${exchange} symbols`, () => {
      for (const bad of ["", 42, "x".repeat(41), "../BTCUSDT", symbol + "?pair=ETH"])
        assert.throws(() => parseMarketConfig({ btc: { usdt: { [exchange]: bad } } }));
    });
  }
  it("keeps vendor aliases separate from the product asset", () => {
    assert.equal(findMarkets("ton", "usdt")?.binance, "GRAMUSDT");
    assert.equal(findMarkets("ton", "usdt")?.bitfinex, "tTONUST");
    assert.equal(findMarkets("usdc", "usd")?.bitfinex, "tUDCUSD");
    assert.equal(findMarkets("gram", "usdt"), undefined);
  });
});
