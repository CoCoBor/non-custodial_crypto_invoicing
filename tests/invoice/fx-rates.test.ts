import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CURRENCY_API_URLS,
  FX_MAX_AGE_MS,
  createUsdToFiat,
  parseCurrencyApi,
  parseExchangeRateApi,
} from "../../src/invoice/fx-rates.js";

// The USD → fiat port. Replies come from tests/fixtures/fx:
// - currency-api-usd.json: recorded from jsDelivr, 2026-11-18 (one public GET, no key);
// - currency-api-usd-pages-dev.json: recorded from the Cloudflare Pages mirror, same day;
// - exchangerate-api-docs-sample.json: ExchangeRate-API's documented sample
//   (https://www.exchangerate-api.com/docs/standard-requests), without its
//   "..." placeholder lines. Not a recorded reply: no real key is ever used.

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/fx/${name}`, import.meta.url), "utf8");
const JSDELIVR = fixture("currency-api-usd.json"); // date 2026-11-17
const PAGES_DEV = fixture("currency-api-usd-pages-dev.json"); // date 2026-11-18
const ER_SAMPLE = fixture("exchangerate-api-docs-sample.json"); // 2020-03-27

const NOV_17 = Date.UTC(2026, 10, 17);
const NOV_18 = Date.UTC(2026, 10, 18);
const KEY = "fake-key-0000";
const ER_URL = `https://v6.exchangerate-api.com/v6/${KEY}/latest/USD`;

describe("parsing the providers' replies", () => {
  it("reads all 11 non-USD codes from the recorded currency-api reply, digit for digit", () => {
    const table = parseCurrencyApi(JSDELIVR);

    assert.equal(table?.at, NOV_17);
    assert.deepEqual(table?.rates, {
      usd: "1",
      eur: "0.90843583",
      gbp: "0.7577151",
      inr: "93.55669247",
      pkr: "276.79307922",
      vnd: "25750.80432375",
      brl: "5.78473607",
      ngn: "1345.92658575",
      idr: "18255.55424501",
      uah: "45.39322427",
      php: "63.74231739",
      myr: "4.09048195",
    });
  });

  it("never picks up RUB, which is in the reply but not an invoice currency", () => {
    assert.match(JSDELIVR, /"rub":/);
    assert.equal((parseCurrencyApi(JSDELIVR)?.rates as Record<string, string>).rub, undefined);
  });

  it("reads ExchangeRate-API's documented reply: uppercase codes, update time in seconds", () => {
    const table = parseExchangeRateApi(ER_SAMPLE);

    assert.equal(table?.at, 1_585_267_200_000);
    assert.deepEqual(table?.rates, { usd: "1", eur: "0.9013", gbp: "0.7679" });
  });

  it("refuses error replies, another base, and rates that are not positive numbers", () => {
    assert.equal(parseExchangeRateApi('{"result":"error","error-type":"invalid-key"}'), undefined);
    assert.equal(parseExchangeRateApi(ER_SAMPLE.replace('"USD",', '"EUR",')), undefined);
    assert.equal(parseExchangeRateApi("not json"), undefined);
    assert.equal(parseCurrencyApi('{"usd":{"eur":0.9}}'), undefined, "no date");
    assert.deepEqual(parseCurrencyApi('{"date":"2026-11-18","usd":{"eur":0,"gbp":-1,"inr":"n/a"}}')?.rates, {});
  });

  it("keeps a rate written in exponent form exact", () => {
    assert.equal(parseCurrencyApi('{"date":"2026-11-18","usd":{"eur":9.0843583e-1}}')?.rates.eur, "0.90843583");
  });
});

/** A fetch that answers from a URL → reply map and records what was asked. */
function fakeFetch(replies: Record<string, string | number>) {
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const reply = replies[url];
    if (reply === undefined || typeof reply === "number") return new Response("", { status: reply ?? 404 });
    return new Response(reply, { status: 200 });
  }) as typeof fetch;
  return { fetchFn, asked };
}

describe("the USD → fiat port", () => {
  it("uses only the keyless fallback when no key is set", async () => {
    const { fetchFn, asked } = fakeFetch({ [CURRENCY_API_URLS[0]]: JSDELIVR });
    const getUsdToFiat = createUsdToFiat({ fetch: fetchFn, now: () => NOV_18 + 8 * 60 * 60 * 1000 });

    assert.deepEqual(await getUsdToFiat("eur"), { rate: "0.90843583", at: NOV_17 });
    assert.deepEqual(asked, [CURRENCY_API_URLS[0]]);
  });

  it("uses ExchangeRate-API first when a key is set", async () => {
    const recentSample = ER_SAMPLE.replace("1585267200,", `${NOV_18 / 1000},`);
    const { fetchFn, asked } = fakeFetch({ [ER_URL]: recentSample, [CURRENCY_API_URLS[0]]: JSDELIVR });
    const getUsdToFiat = createUsdToFiat({ apiKey: KEY, fetch: fetchFn, now: () => NOV_18 + 60_000 });

    assert.deepEqual(await getUsdToFiat("eur"), { rate: "0.9013", at: NOV_18 });
    assert.deepEqual(asked, [ER_URL]);
  });

  it("falls back for a code the primary lacks, and when the primary fails", async () => {
    const recentSample = ER_SAMPLE.replace("1585267200,", `${NOV_18 / 1000},`);
    const now = () => NOV_18 + 60_000;

    const lacking = fakeFetch({ [ER_URL]: recentSample, [CURRENCY_API_URLS[0]]: JSDELIVR });
    assert.deepEqual(
      await createUsdToFiat({ apiKey: KEY, fetch: lacking.fetchFn, now })("inr"),
      { rate: "93.55669247", at: NOV_17 },
    );

    const failing = fakeFetch({ [ER_URL]: 500, [CURRENCY_API_URLS[0]]: JSDELIVR });
    assert.deepEqual(
      await createUsdToFiat({ apiKey: KEY, fetch: failing.fetchFn, now })("eur"),
      { rate: "0.90843583", at: NOV_17 },
    );
  });

  it("refuses the primary's rates once they are older than 48 hours, and uses the fallback", async () => {
    const { fetchFn } = fakeFetch({ [ER_URL]: ER_SAMPLE, [CURRENCY_API_URLS[0]]: JSDELIVR });
    const getUsdToFiat = createUsdToFiat({ apiKey: KEY, fetch: fetchFn, now: () => NOV_18 });

    assert.deepEqual(await getUsdToFiat("gbp"), { rate: "0.7577151", at: NOV_17 });
  });

  it("goes on to the Cloudflare Pages mirror when jsDelivr is down", async () => {
    const { fetchFn, asked } = fakeFetch({ [CURRENCY_API_URLS[0]]: 503, [CURRENCY_API_URLS[1]]: PAGES_DEV });
    const getUsdToFiat = createUsdToFiat({ fetch: fetchFn, now: () => NOV_18 + 60_000 });

    const rate = await getUsdToFiat("vnd");
    assert.equal(rate?.at, NOV_18);
    assert.match(rate?.rate ?? "", /^2[0-9]{4}\.[0-9]+$/);
    assert.deepEqual(asked, [...CURRENCY_API_URLS]);
  });

  it("has no rate when every source is stale or down", async () => {
    const { fetchFn } = fakeFetch({ [ER_URL]: ER_SAMPLE, [CURRENCY_API_URLS[0]]: JSDELIVR, [CURRENCY_API_URLS[1]]: 503 });
    const getUsdToFiat = createUsdToFiat({ apiKey: KEY, fetch: fetchFn, now: () => NOV_17 + FX_MAX_AGE_MS + 1 });

    assert.equal(await getUsdToFiat("eur"), undefined);
  });

  it("caches a source's reply for an hour", async () => {
    let clock = NOV_18;
    const { fetchFn, asked } = fakeFetch({ [CURRENCY_API_URLS[0]]: JSDELIVR });
    const getUsdToFiat = createUsdToFiat({ fetch: fetchFn, now: () => clock });

    await getUsdToFiat("eur");
    await getUsdToFiat("ngn");
    clock += 59 * 60 * 1000;
    await getUsdToFiat("php");
    assert.equal(asked.length, 1);

    clock += 2 * 60 * 1000;
    await getUsdToFiat("php");
    assert.equal(asked.length, 2);
  });

  it("answers 1 for USD without asking anyone, and nothing for a code outside the list", async () => {
    const { fetchFn, asked } = fakeFetch({});
    const getUsdToFiat = createUsdToFiat({ fetch: fetchFn, now: () => NOV_18 });

    assert.equal((await getUsdToFiat("usd"))?.rate, "1");
    assert.equal(await getUsdToFiat("rub" as never), undefined);
    assert.deepEqual(asked, []);
  });
});
