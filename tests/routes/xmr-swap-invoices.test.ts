import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

// Swap mode with XMR on either side, over HTTP, with Exolix on (an API key
// set): the real swap port (NEAR and Exolix behind the router), of which the
// routes use only `supports` (no network). The xmr adapter is pointed
// (MONERO_WALLET_RPC_URL, set before the app loads) at a stand-in for
// monero-wallet-rpc that answers create_address. Exolix off:
// tests/routes/swap-invoices.test.ts.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test.

// Mainnet addresses from Monero's tests/functional_tests/validate_address.py.
const SUBADDRESS = "8AsN91rznfkBGTY8psSNkJBg9SZgxxGGRUhGwRptBhgr5XSQ1XzmA9m8QAnoxydecSh5aLJXdrgXwTDMMZ1AuXsN1EX5Mtm";
const MERCHANT_XMR = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const MERCHANT_TRON = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const PRICES: Record<string, string> = { xmr: "250", btc: "50000", usdttrx: "1" };

let wallet: Server;
let nextIndex = 1;
let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
let postJson: typeof import("../helpers/http-app.js").postJson;
let computeBlindIndex: typeof import("../../src/security/blind-index.js").computeBlindIndex;
const userIds: string[] = [];

before(async () => {
  wallet = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { method } = JSON.parse(body) as { method: string };
      if (method !== "create_address") {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "0", result: { address: SUBADDRESS, address_index: nextIndex++ } }));
    });
  }).listen(0, "127.0.0.1");
  await once(wallet, "listening");
  process.env.MONERO_WALLET_RPC_URL = `http://127.0.0.1:${(wallet.address() as AddressInfo).port}`;

  const helpers = await import("../helpers/http-app.js");
  const { createSwapProvider } = await import("../../src/swap/registry.js");
  postJson = helpers.postJson;
  computeBlindIndex = (await import("../../src/security/blind-index.js")).computeBlindIndex;
  const swap = createSwapProvider({
    fetch: async () => {
      throw new Error("no network in this test");
    },
    nearJwt: "",
    exolixApiKey: "test-exolix-key",
    now: Date.now,
    usdPrice: async (coin) => PRICES[coin],
  });
  ({ baseUrl, db, stop } = await helpers.startTestApp({ getPrice: async (coin) => PRICES[coin], swap }));
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
  wallet.close();
});

async function merchant(payoutAddresses: Record<string, string>) {
  const userId = randomUUID();
  const apiKey = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    api_key_hash: computeBlindIndex("api-key", apiKey),
    merchant_fee: "0.05",
    swap_max_loss_bps: 150,
    payout_addresses: payoutAddresses,
  });
  return { userId, apiKey };
}

async function createSwapInvoice(apiKey: string, body: Record<string, unknown>) {
  return await postJson(`${baseUrl}/invoices`, { amount: "65", mode: "swap", ...body }, { merchant_key: apiKey });
}

describe("swap mode with Exolix on", () => {
  it("offers XMR to the payer, swapped by Exolix, beside NEAR's coins", async () => {
    const m = await merchant({ usdttrx: MERCHANT_TRON });

    const response = await createSwapInvoice(m.apiKey, { to_crypto: "usdttrx" });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const options = response.body.data.coinOptions as { crypto: string; payout: string }[];
    assert.deepEqual(options.find((o) => o.crypto === "xmr"), { crypto: "xmr", payout: "swap" });
    assert.deepEqual(options.find((o) => o.crypto === "btc"), { crypto: "btc", payout: "swap" });
    assert.deepEqual(options.find((o) => o.crypto === "usdttrx"), { crypto: "usdttrx", payout: "direct" });
  });

  it("lets the payer pay in XMR: a subaddress deposit, the rate locked in XMR, USDT on Tron still the receive coin", async () => {
    const m = await merchant({ usdttrx: MERCHANT_TRON });
    const invoiceId: string = (await createSwapInvoice(m.apiKey, { to_crypto: "usdttrx" })).body.data.invoiceId;

    const chosen = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "xmr" });

    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    const invoice = await db.collection("invoices").findOne({ invoice_id: invoiceId });
    assert.equal(invoice?.crypto, "xmr");
    assert.equal(invoice?.address, SUBADDRESS);
    assert.equal(invoice?.to_crypto, "usdttrx");
    assert.equal(invoice?.to_address, MERCHANT_TRON);
    assert.equal(invoice?.locked_rate?.coin_price_usd, "250");
    assert.equal(invoice?.amount, "260000000000", "65 USD at 250 USD per XMR, in piconero");
  });

  it("accepts XMR as the receive coin: every coin Exolix can swap into XMR, and XMR itself paid out directly", async () => {
    const m = await merchant({ xmr: MERCHANT_XMR });

    const response = await createSwapInvoice(m.apiKey, { to_crypto: "xmr" });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.receiveCrypto, "xmr");
    assert.deepEqual(
      [...data.offeredCoins].sort(),
      ["btc", "bsc", "daieth", "eth", "ltc", "sol", "usdceth", "usdteth", "usdtsol", "usdcsol", "usdtton", "usdttrx", "xmr"].sort(),
    );
    assert.ok(!data.offeredCoins.includes("ton"), "Exolix lists no native TON");
    assert.deepEqual(data.coinOptions.find((o: { crypto: string }) => o.crypto === "xmr"), { crypto: "xmr", payout: "direct" });
    const stored = await db.collection("invoices").findOne({ invoice_id: data.invoiceId });
    assert.equal(stored?.to_crypto, "xmr");
    assert.equal(stored?.to_address, MERCHANT_XMR);
    assert.equal(stored?.swap_max_loss_bps, 150);
  });

  it("lets the payer pay BTC into an XMR receive coin", async () => {
    const m = await merchant({ xmr: MERCHANT_XMR });
    const invoiceId: string = (await createSwapInvoice(m.apiKey, { to_crypto: "xmr" })).body.data.invoiceId;

    const chosen = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "btc" });

    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    const invoice = await db.collection("invoices").findOne({ invoice_id: invoiceId });
    assert.equal(invoice?.crypto, "btc");
    assert.equal(invoice?.to_crypto, "xmr");
    assert.equal(invoice?.to_address, MERCHANT_XMR);
  });

  it("still asks for a valid XMR payout address first", async () => {
    const m = await merchant({ btc: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" });
    const response = await createSwapInvoice(m.apiKey, { to_crypto: "xmr" });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "PAYOUT_ADDRESS_REQUIRED");
  });
});
