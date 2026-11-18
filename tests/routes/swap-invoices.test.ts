import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { computeBlindIndex } from "../../src/security/blind-index.js";
import { createSwapProvider } from "../../src/swap/registry.js";
import { postJson, startTestApp } from "../helpers/http-app.js";

// Swap mode over HTTP: the merchant API creates the invoice, the payer picks
// any coin the swap provider and a chain adapter support, and the rate is
// locked at the choice. The swap port is the real one (NEAR and Exolix behind
// the router) with Exolix off (no API key): only `supports` (no network) is
// used here. Exolix on: tests/routes/xmr-swap-invoices.test.ts.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test.

const USDC_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const PRICES: Record<string, string> = { btc: "65000", usdceth: "1", ltc: "45", eth: "1800" };

let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];

before(async () => {
  const swap = createSwapProvider({
    fetch: async () => {
      throw new Error("no network in this test");
    },
    nearJwt: "",
    exolixApiKey: "",
    now: Date.now,
    usdPrice: async (coin) => PRICES[coin],
  });
  ({ baseUrl, db, stop } = await startTestApp({ getPrice: async (coin) => PRICES[coin], swap }));
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
});

async function merchant(payoutAddresses: Record<string, string>, swapMaxLossBps = 200) {
  const userId = randomUUID();
  const apiKey = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    api_key_hash: computeBlindIndex("api-key", apiKey),
    merchant_fee: "0.05",
    swap_max_loss_bps: swapMaxLossBps,
    payout_addresses: payoutAddresses,
  });
  return { userId, apiKey };
}

async function createSwapInvoice(apiKey: string, body: Record<string, unknown> = {}) {
  return await postJson(`${baseUrl}/invoices`, { amount: "65", mode: "swap", to_crypto: "usdceth", ...body }, { merchant_key: apiKey });
}

async function choose(invoiceId: string, crypto: string) {
  return await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto });
}

async function stored(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

describe("creating a swap-mode invoice", () => {
  it("offers every coin the swap provider and a chain adapter support, marking the receive coin as paid out directly", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });

    const response = await createSwapInvoice(m.apiKey);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.mode, "swap");
    assert.equal(data.receiveCrypto, "usdceth");
    assert.deepEqual(
      [...data.offeredCoins].sort(),
      ["btc", "bsc", "daieth", "eth", "ltc", "sol", "ton", "usdceth", "usdteth", "usdtsol", "usdcsol", "usdtton", "usdttrx"].sort(),
    );
    assert.ok(!data.offeredCoins.includes("xmr"), "XMR needs Exolix, which is off");
    assert.deepEqual(
      data.coinOptions.find((o: { crypto: string }) => o.crypto === "usdceth"),
      { crypto: "usdceth", payout: "direct" },
    );
    assert.deepEqual(data.coinOptions.find((o: { crypto: string }) => o.crypto === "btc"), { crypto: "btc", payout: "swap" });

    const invoice = await stored(data.invoiceId);
    assert.equal(invoice?.mode, "swap");
    assert.equal(invoice?.crypto, "");
    assert.equal(invoice?.address, "");
    assert.equal(invoice?.to_crypto, "usdceth");
    assert.equal(invoice?.to_address, USDC_ADDRESS);
    assert.equal(invoice?.swap_max_loss_bps, 200, "the merchant's max loss, copied");
    assert.equal(invoice?.fee_rate, "0.05");
    assert.equal(invoice?.locked_rate, null, "no rate until the payer picks a coin");
  });

  it("offers only the requested coins, plus nothing the provider can't swap", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });

    const response = await createSwapInvoice(m.apiKey, { coins: ["btc", "xmr", "usdceth"] });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body.data.offeredCoins, ["btc", "usdceth"]);
  });

  it("is refused without a valid payout address for the receive coin", async () => {
    const m = await merchant({ btc: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" });

    const response = await createSwapInvoice(m.apiKey);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "PAYOUT_ADDRESS_REQUIRED");
    assert.equal(await db.collection("invoices").countDocuments({ user_id: m.userId }), 0);
  });

  it("is refused for a receive coin no swap can deliver (XMR with Exolix off) or with no chain adapter", async () => {
    const m = await merchant({
      xmr: "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A",
      usdtbsc: USDC_ADDRESS,
    });

    for (const to_crypto of ["xmr", "usdtbsc"]) {
      const response = await createSwapInvoice(m.apiKey, { to_crypto });
      assert.equal(response.status, 409, to_crypto);
      assert.equal(response.body.error.code, "RECEIVE_COIN_NOT_SUPPORTED", to_crypto);
    }
    assert.equal(await db.collection("invoices").countDocuments({ user_id: m.userId }), 0);
  });

  it("refuses an unknown receive coin as an invalid request", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });
    const response = await createSwapInvoice(m.apiKey, { to_crypto: "doge" });
    assert.equal(response.status, 400);
  });
});

describe("the payer choosing a coin on a swap-mode invoice", () => {
  it("locks the rate for the coin paid and keeps the receive coin and address", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });
    const invoiceId: string = (await createSwapInvoice(m.apiKey)).body.data.invoiceId;

    const response = await choose(invoiceId, "btc");

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const payment = response.body.data.payment;
    assert.equal(payment.crypto, "btc");
    assert.equal(payment.amount, "100000", "65 USD at 65,000 USD per BTC");
    assert.equal(payment.swap, true);
    assert.equal(response.body.data.receiveCrypto, "usdceth");
    assert.equal(response.body.data.lockedRate.coinPriceUsd, "65000");

    const invoice = await stored(invoiceId);
    assert.equal(invoice?.crypto, "btc");
    assert.equal(invoice?.to_crypto, "usdceth");
    assert.equal(invoice?.to_address, USDC_ADDRESS);
    assert.ok(invoice?.address, "a BTC deposit address");
    assert.ok(invoice?.private?.private_key, "with its sealed key");
  });

  it("pays the receive coin itself out directly", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });
    const invoiceId: string = (await createSwapInvoice(m.apiKey)).body.data.invoiceId;

    const response = await choose(invoiceId, "usdceth");

    assert.equal(response.status, 200);
    assert.equal(response.body.data.payment.swap, false);
    assert.equal(response.body.data.payment.amount, "65000000");
    const invoice = await stored(invoiceId);
    assert.equal(invoice?.crypto, "usdceth");
    assert.equal(invoice?.to_crypto, "usdceth");
  });

  it("refuses a coin that is not offered (XMR), and a second choice", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });
    const invoiceId: string = (await createSwapInvoice(m.apiKey)).body.data.invoiceId;

    const xmr = await choose(invoiceId, "xmr");
    assert.equal(xmr.status, 409);
    assert.equal(xmr.body.error.code, "COIN_NOT_OFFERED");

    assert.equal((await choose(invoiceId, "btc")).status, 200);
    const again = await choose(invoiceId, "ltc");
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "COIN_ALREADY_CHOSEN");
  });

  it("refuses the choice once the merchant's receive address is gone", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });
    const invoiceId: string = (await createSwapInvoice(m.apiKey)).body.data.invoiceId;
    await db.collection("users").updateOne({ user_id: m.userId }, { $set: { "payout_addresses.usdceth": "" } });

    const response = await choose(invoiceId, "btc");

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "COIN_NOT_OFFERED");
    assert.equal((await stored(invoiceId))?.crypto, "");
  });

  it("shows the payer the coins and which one is paid out directly, never the merchant's address", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });
    const invoiceId: string = (await createSwapInvoice(m.apiKey, { coins: ["btc", "usdceth"] })).body.data.invoiceId;

    const response = await fetch(`${baseUrl}/pay/${invoiceId}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.coins, ["btc", "usdceth"]);
    assert.deepEqual(body.data.coinOptions, [
      { crypto: "btc", payout: "swap" },
      { crypto: "usdceth", payout: "direct" },
    ]);
    assert.ok(!JSON.stringify(body).includes(USDC_ADDRESS));
  });
});

describe("the merchant's view of a swap-mode invoice", () => {
  it("shows the swap: provider, deposit, status, the amount sent in and the amount delivered", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });
    const invoiceId: string = (await createSwapInvoice(m.apiKey)).body.data.invoiceId;
    const view = async () =>
      (await (await fetch(`${baseUrl}/invoices/${invoiceId}`, { headers: { merchant_key: m.apiKey } })).json()).data;

    assert.equal((await view()).mode, "swap");
    assert.equal((await view()).swap, null);

    await db.collection("invoices").updateOne(
      { invoice_id: invoiceId },
      {
        $set: {
          swap: {
            provider: "near_intents",
            deposit_address: "swap-deposit",
            recipient: USDC_ADDRESS,
            receive_crypto: "usdceth",
            status: "SUCCESS",
            deadline: "2026-11-19T12:00:00.000Z",
            amount_in: "94000",
            min_amount_out: "600000",
            amount_delivered: "649990",
            amount_refunded: "0",
            destination_txids: ["0xabc"],
            quote_response: { secret: "not shown" },
          },
        },
      },
    );

    assert.deepEqual((await view()).swap, {
      provider: "near_intents",
      depositAddress: "swap-deposit",
      receiveCrypto: "usdceth",
      recipient: USDC_ADDRESS,
      status: "SUCCESS",
      deadline: "2026-11-19T12:00:00.000Z",
      amountIn: "94000",
      minAmountOut: "600000",
      amountDelivered: "649990",
      amountRefunded: "0",
      refundReason: "",
      deliveryTxids: ["0xabc"],
    });
  });
});

describe("a fixed-coin invoice", () => {
  it("pays out only in the coin paid: BTC paid, USDC received is swap mode now", async () => {
    const m = await merchant({ usdceth: USDC_ADDRESS });

    const response = await postJson(
      `${baseUrl}/invoices`,
      { amount: "65", crypto: "btc", to_crypto: "usdceth" },
      { merchant_key: m.apiKey },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "PAYOUT_NOT_SUPPORTED");
    assert.match(response.body.error.message, /mode "swap"/);
  });
});
