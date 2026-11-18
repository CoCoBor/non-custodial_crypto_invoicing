import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { getPrice, getTicker } from "../../src/invoice/price.function.js";

// XMR's USD price (owner decision 2026-11-19: XT and Bitfinex count for XMR,
// HTX added). Replies come from one snapshot in tests/fixtures/prices-xmr:
// every XMR/USDT market and every weighted USDT/USD market, recorded within
// 1.4 s on 2026-11-18 with one public GET each. No network.

type Recording = { url: string; status: number; file: string; exchange: string };
const snapshot = JSON.parse(
  readFileSync(new URL("../fixtures/prices-xmr/recordings.json", import.meta.url), "utf8"),
) as { finishedAtMs: number; recordings: Recording[] };
const body = (file: string) =>
  readFileSync(new URL(`../fixtures/prices-xmr/${file}`, import.meta.url), "utf8");

const realFetch = globalThis.fetch;
let replies: Map<string, { status: number; body: string }>;
let asked: string[];

function urlOf(exchange: string, market: string): string {
  const r = snapshot.recordings.find((x) => x.exchange === exchange && x.file === `${exchange}-${market}.json`);
  assert.ok(r, `no recording for ${exchange} ${market}`);
  return r.url;
}

function down(exchange: string, market: string) {
  replies.set(urlOf(exchange, market), { status: 503, body: "" });
}

function replace(exchange: string, market: string, text: string) {
  replies.set(urlOf(exchange, market), { status: 200, body: text });
}

beforeEach(() => {
  replies = new Map(snapshot.recordings.map((r) => [r.url, { status: r.status, body: body(r.file) }]));
  asked = [];
  mock.timers.enable({ apis: ["Date"], now: snapshot.finishedAtMs });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const reply = replies.get(url);
    if (!reply) return new Response("", { status: 404 });
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
function product(a: string, b: string): bigint {
  const raw = scaled(a) * scaled(b);
  return raw / SCALE + ((raw % SCALE) * 2n >= SCALE ? 1n : 0n);
}
const AT_36 = (text: string) => {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(36, "0"));
};

describe("HTX market/detail/merged replies", () => {
  it("reads bid, ask, the 24 h base volume and the reply time from the recorded XMR/USDT reply, digit for digit", async () => {
    const recorded = JSON.parse(body("htx-xmrusdt.json"));
    const ticker = await getTicker("htx", "xmr", "usdt");

    assert.ok(ticker, "parsed");
    assert.equal(ticker.bid, AT_36("497.99"));
    assert.equal(ticker.ask, AT_36("498.38"));
    assert.equal(ticker.volume, AT_36("79716.3863821854"));
    assert.equal(ticker.sourceTimeMs, recorded.ts);
    assert.deepEqual(asked, ["https://api.huobi.pro/market/detail/merged?symbol=xmrusdt"]);
  });

  it("refuses an error reply, another market's reply, and a bid above the ask", async () => {
    const recorded = body("htx-xmrusdt.json");

    replace("htx", "xmrusdt", '{"status":"error","err-code":"invalid-parameter","err-msg":"invalid symbol"}');
    assert.equal(await getTicker("htx", "xmr", "usdt"), undefined);

    replace("htx", "xmrusdt", recorded.replace("market.xmrusdt.detail.merged", "market.btcusdt.detail.merged"));
    assert.equal(await getTicker("htx", "xmr", "usdt"), undefined);

    replace("htx", "xmrusdt", recorded.replace('"bid":[497.99,', '"bid":[499.99,'));
    assert.equal(await getTicker("htx", "xmr", "usdt"), undefined);
  });
});

describe("XT's and Bitfinex's recorded XMR/USDT replies", () => {
  it("parse with the existing readers", async () => {
    const xt = await getTicker("xt", "xmr", "usdt");
    const bitfinex = await getTicker("bitfinex", "xmr", "usdt");

    assert.ok(xt && bitfinex);
    assert.equal(xt.volume, AT_36(JSON.parse(body("xt-xmr_usdt.json")).result[0].q));
    assert.ok(bitfinex.volume > 0n && bitfinex.bid <= bitfinex.ask);
  });
});

describe("XMR's USD price", () => {
  it("is its price from 5 XMR/USDT markets (Kraken, KuCoin, XT, Bitfinex, HTX) × the USDT/USD price", async () => {
    const usd = await getPrice("xmr", "usd");
    const inUsdt = await getPrice("xmr", "usdt");
    const usdtInUsd = await getPrice("usdteth", "usd");

    assert.ok(usd && inUsdt && usdtInUsd, `usd ${usd}, usdt ${inUsdt}, usdt/usd ${usdtInUsd}`);
    assert.ok(Number(usd) > 450 && Number(usd) < 550, `xmr ${usd}`);
    assert.equal(scaled(usd), product(inUsdt, usdtInUsd));
    for (const host of ["api.kraken.com", "api.kucoin.com", "sapi.xt.com", "api-pub.bitfinex.com", "api.huobi.pro"]) {
      assert.ok(asked.some((u) => u.includes(host) && /xmr/i.test(u)), `asked ${host} for XMR`);
    }
  });

  it("has a price with 4 XMR/USDT markets answering", async () => {
    down("htx", "xmrusdt");

    assert.ok(await getPrice("xmr", "usd"));
  });

  it("has no price with only 3 XMR/USDT markets answering: the 4-source rule is kept", async () => {
    down("htx", "xmrusdt");
    down("xt", "xmr_usdt");

    assert.equal(await getPrice("xmr", "usdt"), undefined);
    assert.equal(await getPrice("xmr", "usd"), undefined);
  });

  it("still leaves XT and Bitfinex out for every other coin", async () => {
    await getPrice("ltc", "usdt");
    await getPrice("btc", "usd");

    assert.ok(asked.length > 0);
    assert.deepEqual(asked.filter((u) => u.includes("sapi.xt.com") || u.includes("bitfinex")), []);
  });
});
