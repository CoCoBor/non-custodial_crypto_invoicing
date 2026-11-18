import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import litecore from "bitcore-lib-ltc";
import type { Db } from "mongodb";

import { computeBlindIndex } from "../../src/security/blind-index.js";
import cryptos from "../../src/storage/cryptos.json" with { type: "json" };
import { unusedSwap } from "../helpers/fake-swap.js";
import { postJson, startTestApp } from "../helpers/http-app.js";

// Spec story 42: an invoice below the asset's minimum amount is refused, and
// a coin whose amount would be below its minimum is not offered. The amount
// compared is what the payer is asked to send. Prices are set from the
// minimums in cryptos.json, so the owner can change those numbers freely.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test.

const BTC_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const LTC_ADDRESS = new litecore.PrivateKey().toAddress().toString();
const EVM_ADDRESS = "0x000000000000000000000000000000000000dEaD";

type Coin = keyof typeof cryptos;

const minimumOf = (coin: Coin) => BigInt(cryptos[coin].min_invoice_amount);

/** The USD price at which `coin`'s minimum is worth exactly `usd` dollars. */
function priceWhereMinimumIsWorth(coin: Coin, usd: bigint): string {
  const scaled = usd * 10n ** BigInt(cryptos[coin].decimal);
  assert.equal(scaled % minimumOf(coin), 0n, `pick another worth for ${coin}: the price is not a whole number`);
  return (scaled / minimumOf(coin)).toString();
}

/** `units` of `coin` written as a decimal amount of the coin. */
function asCoinAmount(coin: Coin, units: bigint): string {
  const decimals = cryptos[coin].decimal;
  const text = units.toString().padStart(decimals + 1, "0");
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`;
}

let prices: Record<string, string | undefined> = {};
let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];
const NETWORK_COST = 1_000n;

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp({
    getPrice: async (coin) => {
      if (prices[coin] === "throws") throw new Error("price source down");
      return prices[coin];
    },
    estimateNetworkCost: async () => NETWORK_COST,
    swap: unusedSwap(),
  }));
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
});

async function merchant(payoutAddresses: Record<string, string>) {
  const userId = randomUUID();
  const apiKey = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    api_key_hash: computeBlindIndex("api-key", apiKey),
    merchant_fee: "0.05",
    payout_addresses: payoutAddresses,
  });
  return { userId, apiKey };
}

async function createInvoice(apiKey: string, body: Record<string, unknown>) {
  return await postJson(`${baseUrl}/invoices`, body, { merchant_key: apiKey });
}

async function invoicesOf(userId: string) {
  return await db.collection("invoices").find({ user_id: userId }).toArray();
}

describe("the minimums in cryptos.json", () => {
  it("are 10 USD for every stablecoin (owner decision 2026-11-19)", () => {
    const stablecoins = (Object.keys(cryptos) as Coin[]).filter((coin) => /^(usdt|usdc|dai)/.test(coin));
    assert.ok(stablecoins.length >= 10);
    for (const coin of stablecoins) {
      assert.equal(minimumOf(coin), 10n * 10n ** BigInt(cryptos[coin].decimal), coin);
    }
  });
});

describe("the minimum invoice amount", () => {
  it("is set for every coin in the list, as a positive whole number of smallest units", () => {
    for (const [coin, entry] of Object.entries(cryptos)) {
      assert.match(entry.min_invoice_amount, /^[1-9][0-9]*$/, coin);
    }
  });

  it("refuses a fixed-coin invoice one unit below the coin's minimum, and creates nothing", async () => {
    const m = await merchant({ btc: BTC_ADDRESS });
    const below = asCoinAmount("btc", minimumOf("btc") - 1n);

    const response = await createInvoice(m.apiKey, { amount: below, currency: "btc", crypto: "btc", to_crypto: "btc" });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "AMOUNT_BELOW_MINIMUM");
    assert.match(response.body.error.message, new RegExp(`${minimumOf("btc")}`));
    assert.deepEqual(await invoicesOf(m.userId), []);
  });

  it("accepts a fixed-coin invoice of exactly the minimum", async () => {
    const m = await merchant({ btc: BTC_ADDRESS });
    const exact = asCoinAmount("btc", minimumOf("btc"));

    const response = await createInvoice(m.apiKey, { amount: exact, currency: "btc", crypto: "btc", to_crypto: "btc" });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.amount, minimumOf("btc").toString());
  });

  it("compares the coin amount of a fiat-priced invoice", async () => {
    prices = { btc: priceWhereMinimumIsWorth("btc", 2n) };
    const m = await merchant({ btc: BTC_ADDRESS });

    const below = await createInvoice(m.apiKey, { amount: "1.99", crypto: "btc", to_crypto: "btc" });
    const exact = await createInvoice(m.apiKey, { amount: "2", crypto: "btc", to_crypto: "btc" });

    assert.equal(below.status, 400);
    assert.equal(below.body.error.code, "AMOUNT_BELOW_MINIMUM");
    assert.equal(exact.status, 201);
  });

  it("compares what the payer is asked for, so payer-pays fees can lift an invoice over the minimum", async () => {
    const m = await merchant({ btc: BTC_ADDRESS });
    const below = asCoinAmount("btc", minimumOf("btc") - 1n);
    const body = { amount: below, currency: "btc", crypto: "btc", to_crypto: "btc" };

    const merchantPays = await createInvoice(m.apiKey, body);
    const payerPays = await createInvoice(m.apiKey, { ...body, fee_paid_by_payer: true });

    assert.equal(merchantPays.status, 400);
    assert.equal(payerPays.status, 201);
    assert.ok(BigInt(payerPays.body.data.askedAmount) >= minimumOf("btc"));
  });
});

describe("coins offered on an invoice the payer picks the coin for", () => {
  it("leaves out a coin whose amount is below its minimum", async () => {
    // At $2: the BTC minimum is worth $1 (offered), the LTC minimum $4 (not).
    prices = { btc: priceWhereMinimumIsWorth("btc", 1n), ltc: priceWhereMinimumIsWorth("ltc", 4n) };
    const m = await merchant({ btc: BTC_ADDRESS, ltc: LTC_ADDRESS });

    const response = await createInvoice(m.apiKey, { amount: "2", mode: "merchant_list", coins: ["btc", "ltc"] });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body.data.offeredCoins, ["btc"]);
    const page = await (await fetch(`${baseUrl}/pay/${response.body.data.invoiceId}`)).json();
    assert.deepEqual(page.data.coins, ["btc"]);
  });

  it("refuses the invoice when every coin is below its minimum, and creates nothing", async () => {
    prices = { btc: priceWhereMinimumIsWorth("btc", 4n), ltc: priceWhereMinimumIsWorth("ltc", 4n) };
    const m = await merchant({ btc: BTC_ADDRESS, ltc: LTC_ADDRESS });

    const response = await createInvoice(m.apiKey, { amount: "2", mode: "merchant_list", coins: ["btc", "ltc"] });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "AMOUNT_BELOW_MINIMUM");
    assert.deepEqual(await invoicesOf(m.userId), []);
  });

  it("keeps offering a coin it has no price for now: the choice checks again", async () => {
    prices = { btc: priceWhereMinimumIsWorth("btc", 1n) };
    const m = await merchant({ btc: BTC_ADDRESS, ltc: LTC_ADDRESS });

    const response = await createInvoice(m.apiKey, { amount: "2", mode: "merchant_list", coins: ["btc", "ltc"] });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body.data.offeredCoins, ["btc", "ltc"]);
  });

  it("keeps offering a coin whose price lookup throws, rather than failing the invoice", async () => {
    prices = { btc: priceWhereMinimumIsWorth("btc", 1n), ltc: "throws" };
    const m = await merchant({ btc: BTC_ADDRESS, ltc: LTC_ADDRESS });

    const response = await createInvoice(m.apiKey, { amount: "2", mode: "merchant_list", coins: ["btc", "ltc"] });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body.data.offeredCoins, ["btc", "ltc"]);
  });

  it("applies the same rule to the coins of a swap invoice", async () => {
    prices = {
      btc: priceWhereMinimumIsWorth("btc", 1n),
      ltc: priceWhereMinimumIsWorth("ltc", 20n),
      usdceth: priceWhereMinimumIsWorth("usdceth", 10n),
    };
    const m = await merchant({ usdceth: EVM_ADDRESS });

    const response = await createInvoice(m.apiKey, {
      amount: "12",
      mode: "swap",
      to_crypto: "usdceth",
      coins: ["btc", "ltc", "usdceth"],
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body.data.offeredCoins, ["btc", "usdceth"]);
  });

  it("refuses the payer's coin when the price moved it below the minimum since the invoice was made", async () => {
    prices = { btc: priceWhereMinimumIsWorth("btc", 1n) };
    const m = await merchant({ btc: BTC_ADDRESS });
    const created = await createInvoice(m.apiKey, { amount: "2", mode: "merchant_list", coins: ["btc"] });
    assert.equal(created.status, 201);
    const invoiceId = created.body.data.invoiceId;

    prices = { btc: priceWhereMinimumIsWorth("btc", 4n) };
    const choice = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "btc" });

    assert.equal(choice.status, 409);
    assert.equal(choice.body.error.code, "COIN_BELOW_MINIMUM");
    const invoice = await db.collection("invoices").findOne({ invoice_id: invoiceId });
    assert.equal(invoice?.crypto, "");
    assert.equal(invoice?.address, "");
  });
});
