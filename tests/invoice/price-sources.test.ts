import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { getPrice, getTrxPrice } from "../../src/invoice/price.function.js";

// The multi-exchange USD prices, answered from one recorded snapshot of every
// weighted market in src/storage/markets.json (tests/fixtures/prices, all
// recorded within 3 s on 2026-11-18 with one public GET each). No network.
// XMR's markets (XT, Bitfinex and HTX count for XMR since 2026-11-19) have
// their own snapshot: tests/invoice/xmr-price.test.ts.

type Recording = { url: string; status: number; file?: string };
const snapshot = JSON.parse(
  readFileSync(new URL("../fixtures/prices/recordings.json", import.meta.url), "utf8"),
) as { finishedAtMs: number; recordings: Recording[] };

const realFetch = globalThis.fetch;
let replies: Map<string, { status: number; body: string }>;
let unknownUrls: string[];

function recordedReplies() {
  const map = new Map<string, { status: number; body: string }>();
  for (const r of snapshot.recordings) {
    if (!r.file) continue;
    map.set(r.url, {
      status: r.status,
      body: readFileSync(new URL(`../fixtures/prices/${r.file}`, import.meta.url), "utf8"),
    });
  }
  return map;
}

/** Makes every market whose URL matches answer 503, as exchanges that are down. */
function down(...patterns: RegExp[]) {
  for (const pattern of patterns) {
    const urls = [...replies.keys()].filter((u) => pattern.test(u));
    assert.ok(urls.length > 0, `no recorded market matches ${pattern}`);
    for (const url of urls) replies.set(url, { status: 503, body: "" });
  }
}

/** Replaces bid and ask in a Kraken or Gemini reply. */
function quote(urlPart: string, bid: string, ask: string) {
  const url = [...replies.keys()].find((u) => u.includes(urlPart))!;
  const reply = JSON.parse(replies.get(url)!.body);
  if (reply.result) {
    const ticker = Object.values(reply.result)[0] as { a: string[]; b: string[] };
    ticker.b[0] = bid;
    ticker.a[0] = ask;
  } else {
    reply.bid = bid;
    reply.ask = ask;
  }
  replies.set(url, { status: 200, body: JSON.stringify(reply) });
}

beforeEach(() => {
  replies = recordedReplies();
  unknownUrls = [];
  mock.timers.enable({ apis: ["Date"], now: snapshot.finishedAtMs });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const reply = replies.get(url);
    if (!reply) {
      unknownUrls.push(url);
      return new Response("", { status: 404 });
    }
    return new Response(reply.body, { status: reply.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

const SCALE = 10n ** 10n;
function scaled(text: string): bigint {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(10, "0"));
}
/** a × b at 10 decimals, rounded half up, as the price code does. */
function product(a: string, b: string): bigint {
  const raw = scaled(a) * scaled(b);
  return raw / SCALE + ((raw % SCALE) * 2n >= SCALE ? 1n : 0n);
}

describe("USD prices from the recorded snapshot", () => {
  it("prices BTC, ETH and SOL from their own USD markets, as before", async () => {
    const btc = await getPrice("btc", "usd");
    const eth = await getPrice("eth", "usd");
    const sol = await getPrice("sol", "usd");

    assert.ok(btc && Number(btc) > 60_000 && Number(btc) < 70_000, `btc ${btc}`);
    assert.ok(eth && Number(eth) > 1_500 && Number(eth) < 2_000, `eth ${eth}`);
    assert.ok(sol && Number(sol) > 70 && Number(sol) < 80, `sol ${sol}`);
    assert.deepEqual(unknownUrls, []);
  });

  for (const [asset, low, high] of [
    ["ltc", 40, 50],
    ["bsc", 550, 650],
    ["ton", 1, 1.2],
    ["usdceth", 0.99, 1.01],
    ["usdcsol", 0.99, 1.01],
  ] as const) {
    it(`prices ${asset}, whose own USD markets are too few, as its USDT price × the USDT/USD price`, async () => {
      const usd = await getPrice(asset, "usd");
      const inUsdt = await getPrice(asset, "usdt");
      const usdtInUsd = await getPrice("usdteth", "usd");

      assert.ok(inUsdt && usdtInUsd, "both legs have 4 or more sources");
      assert.ok(usd, `${asset} has a USD price`);
      assert.ok(Number(usd) > low && Number(usd) < high, `${asset} ${usd}`);
      assert.equal(scaled(usd), product(inUsdt, usdtInUsd));
    });
  }

  it("prices USDT on every chain from the USDT/USD markets", async () => {
    for (const asset of ["usdteth", "usdtsol", "usdtton", "usdttrx"] as const) {
      const usd = await getPrice(asset, "usd");
      assert.ok(usd && Number(usd) > 0.99 && Number(usd) < 1.01, `${asset} ${usd}`);
    }
  });

  it("prices DAI at the USDC price, which Sky's LitePSM redeems 1:1, while DAI's own markets agree within 1%", async () => {
    const dai = await getPrice("daieth", "usd");
    const usdc = await getPrice("usdceth", "usd");

    assert.ok(usdc);
    assert.equal(dai, usdc);
  });

  it("refuses a DAI price when DAI's own markets are more than 1% off the USDC price", async () => {
    quote("pair=DAIUSD", "0.9790", "0.9800");
    quote("pubticker/daiusd", "0.9790", "0.9800");

    assert.equal(await getPrice("daieth", "usd"), undefined);
  });

  it("refuses a DAI price when only one exchange quotes DAI", async () => {
    down(/pubticker\/daiusd$/);

    assert.equal(await getPrice("daieth", "usd"), undefined);
  });

  it("prices TRX in USDT for the Tron gas reimbursement", async () => {
    const trx = await getTrxPrice("usdt");
    assert.ok(trx && Number(trx) > 0.1 && Number(trx) < 1, `trx ${trx}`);
  });
});

describe("the 4-source rule", () => {
  it("is kept on the USDT leg: LTC has no price with only 3 LTC/USDT markets answering", async () => {
    down(/api\.mexc\.com.*LTCUSDT$/, /LTC-USDT$/, /LTC_USDT$/); // MEXC, OKX, KuCoin, Gate, Crypto.com
    // Left: Kraken, Binance and Bybit.
    assert.equal(await getPrice("ltc", "usdt"), undefined);
    assert.equal(await getPrice("ltc", "usd"), undefined);
  });

  it("is kept on the USDT/USD leg: LTC has no price with only 3 USDT/USD markets answering", async () => {
    down(/pair=USDTZUSD$/, /symbol=USDTUSD$/, /instId=USDT-USD$/); // Kraken, Binance, Bybit, OKX: 2 left

    assert.equal(await getPrice("ltc", "usd"), undefined);
  });

  it("uses BTC's own USD markets while 4 answer, and the USDT route only when they don't", async () => {
    const direct = await getPrice("btc", "usd");
    down(/pair=XXBTZUSD$/, /symbol=BTCUSD$/); // Kraken, Binance, Bybit: 3 left
    const crossed = await getPrice("btc", "usd");
    const inUsdt = await getPrice("btc", "usdt");
    const usdtInUsd = await getPrice("usdteth", "usd");

    assert.ok(direct && crossed && inUsdt && usdtInUsd);
    assert.notEqual(direct, crossed);
    assert.equal(scaled(crossed), product(inUsdt, usdtInUsd));
  });
});
