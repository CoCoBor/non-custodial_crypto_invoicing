import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import litecore from "bitcore-lib-ltc";
import type { Db } from "mongodb";

import type { FxRate } from "../../src/invoice/fx-rates.js";
import { computeBlindIndex } from "../../src/security/blind-index.js";
import type { FiatCode } from "../../src/storage/currencies.js";
import { postJson, startTestApp } from "../helpers/http-app.js";

// Invoices priced in a fiat currency other than USD, or in crypto, through
// the merchant API and the payer's page. The coin/USD prices and the USD →
// fiat rates are fakes at the AppDeps ports.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test

const BTC_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const LTC_ADDRESS = new litecore.PrivateKey().toAddress().toString();
const PRICES: Record<string, string> = { btc: "50000", ltc: "100" }; // USD per coin
const HOUR = 60 * 60 * 1000;

let fx: Partial<Record<FiatCode, FxRate>>;
let fxCalls: string[];
let priceCalls: string[];
let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];
const FX_AT = Date.now() - HOUR;

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp({
    getPrice: async (coin) => {
      priceCalls.push(coin);
      return PRICES[coin];
    },
    getUsdToFiat: async (currency) => {
      fxCalls.push(currency);
      return fx[currency];
    },
    estimateNetworkCost: async (coin) => (coin === "btc" ? 2_440n : "unsupported"),
  }));
});

beforeEach(() => {
  fx = { eur: { rate: "0.8", at: FX_AT }, vnd: { rate: "26000", at: FX_AT } };
  fxCalls = [];
  priceCalls = [];
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
});

async function merchant(fee = "0.05") {
  const userId = randomUUID();
  const apiKey = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    api_key_hash: computeBlindIndex("api-key", apiKey),
    merchant_fee: fee,
    payout_addresses: { btc: BTC_ADDRESS, ltc: LTC_ADDRESS },
  });
  return { userId, apiKey };
}

async function createInvoice(apiKey: string, body: Record<string, unknown>) {
  return await postJson(`${baseUrl}/invoices`, body, { merchant_key: apiKey });
}

async function fixed(apiKey: string, body: Record<string, unknown>) {
  return await createInvoice(apiKey, { crypto: "btc", to_crypto: "btc", ...body });
}

async function choose(invoiceId: string, crypto: string) {
  return await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto });
}

async function invoiceInDb(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

async function merchantView(apiKey: string, invoiceId: string) {
  const response = await fetch(`${baseUrl}/invoices/${invoiceId}`, { headers: { merchant_key: apiKey } });
  return (await response.json()).data;
}

async function payerView(invoiceId: string) {
  return (await (await fetch(`${baseUrl}/pay/${invoiceId}`)).json()).data;
}

describe("a fixed-coin invoice priced in fiat", () => {
  it("converts EUR → USD → BTC at the FX rate and the coin price, and stores the rate it used", async () => {
    const m = await merchant();

    const response = await fixed(m.apiKey, { amount: "25", currency: "EUR" });

    assert.equal(response.status, 201);
    const data = response.body.data;
    // €25 at €0.8 per USD = $31.25; at $50,000/BTC = 0.000625 BTC
    assert.equal(data.amount, "62500");
    assert.equal(data.askedAmount, "62500");
    assert.equal(data.currency, "eur");
    assert.equal(data.amountFiat, "2500");
    assert.deepEqual(data.price, { unit: "eur", amount: "25" });
    assert.equal(data.lockedRate.fiatPerUsd, "0.8");
    assert.equal(data.lockedRate.fiatPerUsdAt, FX_AT);
    assert.equal(data.lockedRate.coinPriceUsd, "50000");
    assert.equal(typeof data.lockedRate.coinPriceUsdAt, "number");
    assert.equal(data.lockedRate.priceAssetPriceUsd, null);
    assert.deepEqual(fxCalls, ["eur"]);

    const invoice = await invoiceInDb(data.invoiceId);
    assert.equal(invoice?.currency, "eur");
    assert.equal(invoice?.amount_fiat, "2500");
    assert.equal(invoice?.locked_rate?.fiat_per_usd, "0.8");
    assert.equal(invoice?.locked_rate?.fiat_per_usd_at, FX_AT);
    assert.equal(invoice?.locked_rate?.coin_price_usd, "50000");
    assert.equal(invoice?.locked_rate?.locked_at, data.lockedRate.lockedAt);
  });

  it("rounds up, so the payer is never asked for less than the price", async () => {
    const m = await merchant();
    fx.eur = { rate: "0.7", at: FX_AT };

    const response = await fixed(m.apiKey, { amount: "25", currency: "eur" });

    // €25 / 0.7 = $35.714285…; / 50,000 = 71,428.57… sat → 71,429
    assert.equal(response.body.data.amount, "71429");
  });

  it("prices in VND, which has no minor unit, and refuses VND decimals", async () => {
    const m = await merchant();

    const response = await fixed(m.apiKey, { amount: "650000", currency: "VND" });
    const fraction = await fixed(m.apiKey, { amount: "650000.5", currency: "VND" });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.amount, "50000"); // ₫650,000 / 26,000 = $25
    assert.equal(response.body.data.amountFiat, "650000");
    assert.deepEqual(response.body.data.price, { unit: "vnd", amount: "650000" });
    assert.equal(fraction.status, 400);
    assert.equal(fraction.body.error.code, "INVALID_PAYMENT");
  });

  it("keeps USD as before: the default, cents, and no FX call", async () => {
    const m = await merchant();

    const response = await fixed(m.apiKey, { amount: "25" });
    const cents = await fixed(m.apiKey, { amount: "25.001" });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.amount, "50000");
    assert.equal(response.body.data.currency, "usd");
    assert.equal(response.body.data.amountFiat, "2500");
    assert.equal(response.body.data.lockedRate.fiatPerUsd, "1");
    assert.equal(response.body.data.lockedRate.fiatPerUsdAt, null);
    assert.equal(cents.status, 400);
    assert.deepEqual(fxCalls, []);
  });

  it("asks a payer-pays payer for the fees on top of the converted amount", async () => {
    const m = await merchant("0.05");

    const response = await fixed(m.apiKey, { amount: "25", currency: "eur", fee_paid_by_payer: true });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.amount, "62500");
    // (62,500 + 2,440) / 0.95 = 68,357.89… → 68,358
    assert.equal(response.body.data.askedAmount, "68358");
  });
});

describe("currencies that are refused", () => {
  for (const currency of ["RUB", "rub", "XYZ", "", "usdt"]) {
    it(`refuses ${JSON.stringify(currency)} with 400 in both modes, and creates nothing`, async () => {
      const m = await merchant();

      const fixedResponse = await fixed(m.apiKey, { amount: "25", currency });
      const listResponse = await createInvoice(m.apiKey, { amount: "25", currency, mode: "merchant_list" });

      assert.equal(fixedResponse.status, 400);
      assert.equal(fixedResponse.body.error.code, "UNSUPPORTED_CURRENCY");
      assert.equal(listResponse.status, 400);
      assert.equal(listResponse.body.error.code, "UNSUPPORTED_CURRENCY");
      assert.equal(await db.collection("invoices").countDocuments({ user_id: m.userId }), 0);
    });
  }
});

describe("FX rates that can't be used", () => {
  it("answers 503 PRICE_UNAVAILABLE without a rate, and creates nothing", async () => {
    const m = await merchant();
    delete fx.eur;

    const response = await fixed(m.apiKey, { amount: "25", currency: "eur" });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "PRICE_UNAVAILABLE");
    assert.equal(await db.collection("invoices").countDocuments({ user_id: m.userId }), 0);
  });

  it("answers 503 PRICE_UNAVAILABLE for a rate older than 48 hours", async () => {
    const m = await merchant();
    fx.eur = { rate: "0.8", at: Date.now() - 49 * HOUR };

    const response = await fixed(m.apiKey, { amount: "25", currency: "eur" });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "PRICE_UNAVAILABLE");
  });

  it("answers 503 at the payer's coin choice, and changes nothing", async () => {
    const m = await merchant();
    const created = await createInvoice(m.apiKey, { amount: "25", currency: "eur", mode: "merchant_list" });
    delete fx.eur;

    const choice = await choose(created.body.data.invoiceId, "btc");

    assert.equal(choice.status, 503);
    assert.equal(choice.body.error.code, "PRICE_UNAVAILABLE");
    assert.equal((await invoiceInDb(created.body.data.invoiceId))?.crypto, "");
  });
});

describe("an invoice priced in crypto", () => {
  it("asks for the price itself when the deposit coin is the price asset, with no price lookup", async () => {
    const m = await merchant();

    const response = await fixed(m.apiKey, { amount: "0.001", currency: "btc" });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.amount, "100000");
    assert.deepEqual(response.body.data.price, { unit: "btc", amount: "0.001" });
    assert.equal(response.body.data.lockedRate.coinPriceUsd, null);
    assert.equal(response.body.data.lockedRate.priceAssetPriceUsd, null);
    assert.equal(response.body.data.lockedRate.fiatPerUsd, null);
    assert.deepEqual(priceCalls, []);
    assert.deepEqual(fxCalls, []);
  });

  it("converts a BTC price into LTC through USD", async () => {
    const m = await merchant();

    const response = await fixed(m.apiKey, { amount: "0.001", currency: "btc", crypto: "ltc", to_crypto: "ltc" });

    assert.equal(response.status, 201);
    // 0.001 BTC × $50,000 = $50; / $100 per LTC = 0.5 LTC
    assert.equal(response.body.data.amount, "50000000");
    assert.equal(response.body.data.lockedRate.priceAssetPriceUsd, "50000");
    assert.equal(response.body.data.lockedRate.coinPriceUsd, "100");
    assert.equal((await invoiceInDb(response.body.data.invoiceId))?.locked_rate?.price_asset_price_usd, "50000");
  });

  it("refuses more decimals than the price asset has", async () => {
    const m = await merchant();

    const response = await fixed(m.apiKey, { amount: "0.000000001", currency: "btc" });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_PAYMENT");
  });

  it("converts at the payer's choice on a merchant's-list invoice, paid in LTC or in BTC", async () => {
    const m = await merchant();
    const inLtc = await createInvoice(m.apiKey, { amount: "0.001", currency: "btc", mode: "merchant_list" });
    const inBtc = await createInvoice(m.apiKey, { amount: "0.001", currency: "btc", mode: "merchant_list" });
    assert.equal(inLtc.status, 201);
    assert.deepEqual(inLtc.body.data.price, { unit: "btc", amount: "0.001" });
    assert.deepEqual(priceCalls, [], "no price is locked before the payer picks a coin");

    const ltcChoice = await choose(inLtc.body.data.invoiceId, "ltc");
    const btcChoice = await choose(inBtc.body.data.invoiceId, "btc");

    assert.equal(ltcChoice.status, 200);
    assert.equal(ltcChoice.body.data.payment.amount, "50000000");
    assert.equal(ltcChoice.body.data.lockedRate.priceAssetPriceUsd, "50000");
    assert.equal(btcChoice.status, 200);
    assert.equal(btcChoice.body.data.payment.amount, "100000");
  });
});

describe("a merchant's-list invoice priced in fiat", () => {
  it("converts EUR at the payer's choice, and shows the price and the locked rate", async () => {
    const m = await merchant();
    const created = await createInvoice(m.apiKey, { amount: "25", currency: "eur", mode: "merchant_list" });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.data.price, { unit: "eur", amount: "25" });
    assert.deepEqual(fxCalls, [], "the rate is locked at the choice, not at creation");

    const choice = await choose(created.body.data.invoiceId, "btc");

    assert.equal(choice.status, 200);
    assert.equal(choice.body.data.payment.amount, "62500");
    assert.deepEqual(choice.body.data.price, { unit: "eur", amount: "25" });
    assert.equal(choice.body.data.lockedRate.fiatPerUsd, "0.8");
    assert.equal(choice.body.data.lockedRate.coinPriceUsd, "50000");
    const invoice = await invoiceInDb(created.body.data.invoiceId);
    assert.equal(invoice?.amount, "62500");
    assert.equal(invoice?.locked_rate?.fiat_per_usd, "0.8");
  });

  it("converts VND into LTC at the choice", async () => {
    const m = await merchant();
    const created = await createInvoice(m.apiKey, { amount: "650000", currency: "vnd", mode: "merchant_list" });

    const choice = await choose(created.body.data.invoiceId, "ltc");

    assert.equal(choice.status, 200);
    assert.equal(choice.body.data.payment.amount, "25000000"); // $25 / $100 = 0.25 LTC
  });

  it("asks a payer-pays payer for the fees on top of the converted amount at the choice", async () => {
    const m = await merchant("0.05");
    const created = await createInvoice(m.apiKey, {
      amount: "25",
      currency: "eur",
      mode: "merchant_list",
      fee_paid_by_payer: true,
    });

    const choice = await choose(created.body.data.invoiceId, "btc");

    assert.equal(choice.status, 200);
    assert.equal(choice.body.data.payment.amount, "68358");
    assert.equal((await invoiceInDb(created.body.data.invoiceId))?.amount, "62500");
  });
});

describe("the locked rate", () => {
  it("stays put on a fixed-coin invoice after the FX rate changes", async () => {
    const m = await merchant();
    const created = await fixed(m.apiKey, { amount: "25", currency: "eur" });
    fx.eur = { rate: "0.5", at: Date.now() };

    const merchantSide = await merchantView(m.apiKey, created.body.data.invoiceId);
    const payerSide = await payerView(created.body.data.invoiceId);

    assert.equal(merchantSide.amount, "62500");
    assert.equal(merchantSide.lockedRate.fiatPerUsd, "0.8");
    assert.deepEqual(merchantSide.price, { unit: "eur", amount: "25" });
    assert.equal(payerSide.payment.amount, "62500");
    assert.equal(payerSide.lockedRate.fiatPerUsd, "0.8");
  });

  it("is taken at the choice on a merchant's-list invoice, then stays put", async () => {
    const m = await merchant();
    const created = await createInvoice(m.apiKey, { amount: "25", currency: "eur", mode: "merchant_list" });
    fx.eur = { rate: "0.5", at: Date.now() };

    const choice = await choose(created.body.data.invoiceId, "btc");
    fx.eur = { rate: "0.8", at: Date.now() };
    const later = await payerView(created.body.data.invoiceId);
    const merchantSide = await merchantView(m.apiKey, created.body.data.invoiceId);

    // €25 / 0.5 = $50 → 100,000 sat
    assert.equal(choice.body.data.payment.amount, "100000");
    assert.equal(later.payment.amount, "100000");
    assert.equal(later.lockedRate.fiatPerUsd, "0.5");
    assert.equal(merchantSide.amount, "100000");
    assert.equal(merchantSide.lockedRate.fiatPerUsd, "0.5");
  });
});
