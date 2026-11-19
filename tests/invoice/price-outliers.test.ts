import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { getPrice } from "../../src/invoice/price.function.js";
import cryptos from "../../src/storage/cryptos.json" with { type: "json" };
import marketConfig from "../../src/storage/markets.json" with { type: "json" };

// Outlier dropping (owner decision 2026-11-20): in each price leg, an exchange
// whose bid/ask midpoint is more than 2.5% (crypto pairs) or 1% (stablecoin
// pairs) from the median midpoint is left out before the volume-weighted average.
// Every exchange reply here is built from the quotes a test sets; an exchange
// with no quote answers 503. No network.

const NOW = 1_790_000_000_000;

type Quote = { bid: string; ask: string; volume: string };
const markets = marketConfig as Record<string, Record<string, Record<string, string>>>;

const hosts: Record<string, string> = {
  "api.binance.com": "binance",
  "api.bybit.com": "bybit",
  "www.okx.com": "okx",
  "api.gateio.ws": "gate",
  "api.kraken.com": "kraken",
  "api.mexc.com": "mexc",
  "api.kucoin.com": "kucoin",
  "api.crypto.com": "cryptocom",
  "sapi.xt.com": "xt",
  "api.gemini.com": "gemini",
  "api-pub.bitfinex.com": "bitfinex",
  "api.huobi.pro": "htx",
};

/** Which pair an exchange's market name belongs to, from markets.json. */
function pairOf(exchange: string, market: string): { coin: string; currency: string } | undefined {
  for (const [coin, byCurrency] of Object.entries(markets)) {
    for (const [currency, byExchange] of Object.entries(byCurrency)) {
      if (byExchange[exchange] === market) return { coin, currency };
    }
  }
  return undefined;
}

/** The reply each exchange gives for one quote, in its own format. */
function replyBody(exchange: string, market: string, currency: string, q: Quote): string {
  const { bid, ask, volume } = q;
  switch (exchange) {
    case "binance":
    case "mexc":
      return JSON.stringify({ symbol: market, bidPrice: bid, askPrice: ask, volume, closeTime: NOW });
    case "bybit":
      return JSON.stringify({
        retCode: 0,
        time: NOW,
        result: { category: "spot", list: [{ symbol: market, bid1Price: bid, ask1Price: ask, volume24h: volume }] },
      });
    case "okx":
      return JSON.stringify({
        code: "0",
        data: [{ instType: "SPOT", instId: market, bidPx: bid, askPx: ask, vol24h: volume, ts: String(NOW) }],
      });
    case "gate":
      return JSON.stringify([{ currency_pair: market, highest_bid: bid, lowest_ask: ask, base_volume: volume }]);
    case "kraken":
      return JSON.stringify({ error: [], result: { [market]: { b: [bid], a: [ask], v: ["0", volume] } } });
    case "kucoin":
      return JSON.stringify({ code: "200000", data: { symbol: market, buy: bid, sell: ask, vol: volume, time: NOW } });
    case "cryptocom":
      return JSON.stringify({ code: 0, result: { data: [{ i: market, b: bid, k: ask, v: volume, t: NOW }] } });
    case "xt":
      return JSON.stringify({ rc: 0, result: [{ s: market, bp: bid, ap: ask, q: volume, t: NOW }] });
    case "gemini":
      return JSON.stringify({
        bid,
        ask,
        volume: { [market.slice(0, -currency.length).toUpperCase()]: volume, timestamp: NOW },
      });
    // Bitfinex and HTX answer JSON numbers, which the reader takes from their source text.
    case "bitfinex":
      return `[["${market}",${bid},1,${ask},1,0,0,0,${volume}]]`;
    case "htx":
      return `{"status":"ok","ch":"market.${market}.detail.merged","ts":${NOW},"tick":{"bid":[${bid},1],"ask":[${ask},1],"amount":${volume}}}`;
    default:
      throw new Error(`no reply format for ${exchange}`);
  }
}

const realFetch = globalThis.fetch;
let quotes: Map<string, Map<string, Quote>>;
let warnings: string[];

/** Sets what one pair's exchanges answer; the pair's other exchanges answer 503. */
function set(pair: string, byExchange: Record<string, Quote>) {
  const [coin, currency] = pair.split("/");
  for (const exchange of Object.keys(byExchange)) {
    assert.ok(markets[coin]?.[currency]?.[exchange], `${exchange} has no ${pair} market in markets.json`);
  }
  quotes.set(pair, new Map(Object.entries(byExchange)));
}

/** A quote with its bid/ask midpoint at `mid` (bid = ask = mid). */
function at(mid: string, volume = "1"): Quote {
  return { bid: mid, ask: mid, volume };
}

beforeEach(() => {
  quotes = new Map();
  warnings = [];
  mock.timers.enable({ apis: ["Date"], now: NOW });
  mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const exchange = hosts[url.host];
    const market = decodeURIComponent(url.href.split(/[=/]/).pop()!);
    const pair = exchange ? pairOf(exchange, market) : undefined;
    const quote = pair && quotes.get(`${pair.coin}/${pair.currency}`)?.get(exchange);
    if (!pair || !quote) return new Response("", { status: 503 });
    return new Response(replyBody(exchange, market, pair.currency, quote), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
  mock.restoreAll();
});

function units(text: string): bigint {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(10, "0"));
}

/** Σ(mid × volume) / Σ volume at 10 decimals, rounded half up, from bid = ask = mid quotes. */
function weightedAverage(...qs: Quote[]): bigint {
  let weighted = 0n;
  let volume = 0n;
  for (const q of qs) {
    weighted += units(q.bid) * units(q.volume);
    volume += units(q.volume);
  }
  return weighted / volume + ((weighted % volume) * 2n >= volume ? 1n : 0n);
}

/** a × b at 10 decimals, rounded half up, as the USDT route does. */
function product(a: string, b: string): bigint {
  const raw = units(a) * units(b);
  const scale = 10n ** 10n;
  return raw / scale + ((raw % scale) * 2n >= scale ? 1n : 0n);
}

const XMR_USDT = ["kraken", "kucoin", "xt", "bitfinex", "htx"] as const;

describe("a far-off exchange is left out of the average", () => {
  it("drops XT 8% low on XMR/USDT (the broken-feed case in the research) and averages the other 4", async () => {
    const good = {
      kraken: at("400.10", "900"),
      kucoin: at("399.80", "300"),
      bitfinex: at("400.40", "50"),
      htx: at("400.00", "700"),
    };
    set("xmr/usdt", { ...good, xt: at("368.00", "200") });

    const price = await getPrice("xmr", "usdt");

    assert.ok(price, "4 sources remain");
    assert.equal(units(price), weightedAverage(...Object.values(good)));
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], /xmr\/usdt/);
    assert.match(warnings[0], /\bxt\b.*-8\.0\d%/);
  });

  it("drops an outlier however large its volume", async () => {
    const good = { kraken: at("400"), kucoin: at("400"), bitfinex: at("401"), htx: at("399") };
    set("xmr/usdt", { ...good, xt: at("432", "1000000000") });

    const price = await getPrice("xmr", "usdt");

    assert.ok(price);
    assert.equal(units(price), weightedAverage(...Object.values(good)));
  });

  it("uses each exchange's bid/ask midpoint, not its bid or ask", async () => {
    // XT's bid is 4% under the others and its ask 4% over; its midpoint agrees.
    set("xmr/usdt", {
      kraken: at("400"),
      kucoin: at("400"),
      bitfinex: at("400"),
      htx: at("400"),
      xt: { bid: "384", ask: "416", volume: "1" },
    });

    const price = await getPrice("xmr", "usdt");
    assert.ok(price);
    assert.equal(units(price), units("400"));
    assert.deepEqual(warnings, []);
  });
});

describe("the limit is 2.5% on crypto pairs", () => {
  for (const [xt, kept] of [
    ["102.4", true],
    ["102.5", true],
    ["102.6", false],
    ["97.6", true],
    ["97.5", true],
    ["97.4", false],
  ] as const) {
    it(`${kept ? "keeps" : "drops"} a source at ${xt} when the median is 100${xt === "102.5" || xt === "97.5" ? " (exactly at the limit: kept)" : ""}`, async () => {
      const good = { kraken: at("100"), kucoin: at("100"), bitfinex: at("100"), htx: at("100") };
      set("xmr/usdt", { ...good, xt: at(xt) });

      const price = await getPrice("xmr", "usdt");

      assert.ok(price);
      const expected = kept ? weightedAverage(...Object.values(good), at(xt)) : weightedAverage(...Object.values(good));
      assert.equal(units(price), expected);
      assert.equal(warnings.length, kept ? 0 : 1);
    });
  }

  it("keeps a crypto source 1.1% off, which a stablecoin pair would drop", async () => {
    set("xmr/usdt", { kraken: at("100"), kucoin: at("100"), bitfinex: at("100"), htx: at("100"), xt: at("101.1") });

    const price = await getPrice("xmr", "usdt");

    assert.ok(price);
    assert.equal(units(price), weightedAverage(at("100"), at("100"), at("100"), at("100"), at("101.1")));
  });
});

describe("the limit is 1% on stablecoin pairs", () => {
  const usdtUsd = { binance: at("1"), bybit: at("1"), cryptocom: at("1"), gemini: at("1") };

  for (const [okx, kept] of [
    ["1.009", true],
    ["1.01", true],
    ["1.011", false],
    ["0.989", false],
  ] as const) {
    it(`${kept ? "keeps" : "drops"} a USDT/USD source at ${okx} when the median is 1${okx === "1.01" ? " (exactly at the limit: kept)" : ""}`, async () => {
      set("usdt/usd", { ...usdtUsd, okx: at(okx) });

      const price = await getPrice("usdteth", "usd");

      assert.ok(price);
      const expected = kept ? weightedAverage(...Object.values(usdtUsd), at(okx)) : weightedAverage(...Object.values(usdtUsd));
      assert.equal(units(price), expected);
    });
  }

  it("treats USDC/USDT (both sides stablecoins) as a stablecoin pair", async () => {
    const good = { binance: at("1"), bybit: at("1"), gate: at("1"), kraken: at("1") };
    set("usdc/usdt", { ...good, okx: at("1.011") });

    const price = await getPrice("usdceth", "usdt");

    assert.ok(price);
    assert.equal(units(price), weightedAverage(...Object.values(good)));
  });

  it("treats USDC/USD as a stablecoin pair", async () => {
    set("usdc/usd", { binance: at("1"), bitfinex: at("1"), gemini: at("1"), kraken: at("1.0105") });

    // Kraken is 1.05% off the median (1): dropped, leaving 3 own USD sources, so no
    // direct price. USDC has no USDT quotes here, so the USDT route has none either.
    assert.equal(await getPrice("usdceth", "usd"), undefined);
    assert.equal(warnings.length, 1);
  });

  it("marks USDT, USDC and DAI, and no other coin, as USD stablecoins in the coin list", () => {
    const flagged = new Set<string>();
    const bySymbol = new Map<string, Set<boolean>>();
    for (const asset of Object.values(cryptos) as { symbol: string; usd_stablecoin?: boolean }[]) {
      const flag = asset.usd_stablecoin === true;
      if (flag) flagged.add(asset.symbol);
      bySymbol.set(asset.symbol, (bySymbol.get(asset.symbol) ?? new Set()).add(flag));
    }
    assert.deepEqual([...flagged].sort(), ["dai", "usdc", "usdt"]);
    for (const [symbol, flags] of bySymbol) {
      assert.equal(flags.size, 1, `every ${symbol} entry must agree on usd_stablecoin`);
    }
  });
});

describe("fewer than 4 sources left after dropping", () => {
  it("gives no price for the leg", async () => {
    set("xmr/usdt", { kraken: at("400"), kucoin: at("400"), bitfinex: at("400"), htx: at("368"), xt: at("368") });

    assert.equal(await getPrice("xmr", "usdt"), undefined);
    assert.equal(warnings.length, 1, "one line for the leg");
    assert.match(warnings[0], /\bhtx\b/);
    assert.match(warnings[0], /\bxt\b/);
  });

  it("still lets a refused direct USD price fall back to coin/USDT × USDT/USD when those legs are clean", async () => {
    // 5 BTC/USD sources, 2 of them 10% high: 3 left, so no direct price.
    set("btc/usd", {
      binance: at("60000"),
      bybit: at("60000"),
      cryptocom: at("60000"),
      gemini: at("66000"),
      kraken: at("66000"),
    });
    const btcUsdt = { binance: at("60100", "3"), okx: at("60050"), kucoin: at("60000"), xt: at("60150", "2") };
    set("btc/usdt", btcUsdt);
    const usdtUsd = { binance: at("0.9998"), bybit: at("1.0002"), okx: at("1"), kraken: at("1.0001") };
    set("usdt/usd", usdtUsd);

    const price = await getPrice("btc", "usd");

    const inUsdt = weightedAverage(...Object.values(btcUsdt));
    const usdtInUsd = weightedAverage(...Object.values(usdtUsd));
    assert.ok(price, "priced through USDT");
    const decimal = (n: bigint) => `${n / 10n ** 10n}.${(n % 10n ** 10n).toString().padStart(10, "0")}`;
    assert.equal(units(price), product(decimal(inUsdt), decimal(usdtInUsd)));
  });

  it("applies the 1% limit inside the USDT route's USDT/USD leg: a source 2% off is dropped, leaving 3, so no USD price", async () => {
    set("xmr/usdt", { kraken: at("400"), kucoin: at("400"), bitfinex: at("400"), htx: at("400") });
    set("usdt/usd", { binance: at("1"), bybit: at("1"), okx: at("1"), kraken: at("0.98") });

    assert.ok(await getPrice("xmr", "usdt"));
    assert.equal(await getPrice("xmr", "usd"), undefined);
  });
});

describe("the median of an even number of sources", () => {
  it("is the mean of the two middle midpoints", async () => {
    // Median 102.5: 100 and 105 are both 2.44% off, so all 6 stay. A lower-middle
    // median (100) would drop the three at 105, an upper-middle one (105) the three at 100.
    const six = {
      binance: at("100"),
      bybit: at("100"),
      gate: at("100"),
      kucoin: at("105"),
      okx: at("105"),
      xt: at("105"),
    };
    set("bnb/usdt", six);

    const price = await getPrice("bsc", "usdt");

    assert.ok(price);
    assert.equal(units(price), units("102.5"));
    assert.deepEqual(warnings, []);
  });

  it("drops by distance from it: 100, 101, 102, 102, 103, 106", async () => {
    // Median (102 + 102) / 2 = 102. 106 is 3.92% off (dropped); 100 is 1.96% off (kept).
    set("bnb/usdt", {
      binance: at("100"),
      bybit: at("101"),
      gate: at("103"),
      kucoin: at("102"),
      okx: at("106"),
      xt: at("102"),
    });

    const price = await getPrice("bsc", "usdt");

    assert.ok(price);
    assert.equal(units(price), weightedAverage(at("100"), at("101"), at("103"), at("102"), at("102")));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\bokx\b/);
  });
});
