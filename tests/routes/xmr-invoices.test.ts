import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

// XMR invoices over HTTP, with the real chain registry: the xmr adapter is
// pointed (MONERO_WALLET_RPC_URL, set before the app loads) at a stand-in
// for monero-wallet-rpc that answers create_address. The regtest suite
// (tests/chains/monero/xmr-payouts.test.ts) covers the real wallet.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test

// Mainnet subaddresses from Monero's tests/functional_tests/validate_address.py.
const SUBADDRESSES = [
  "8AsN91rznfkBGTY8psSNkJBg9SZgxxGGRUhGwRptBhgr5XSQ1XzmA9m8QAnoxydecSh5aLJXdrgXwTDMMZ1AuXsN1EX5Mtm",
  "86kKnBKFqzCLxtK1Jmx2BkNBDBSMDEVaRYMMyVbeURYDWs8uNGDZURKCA5yRcyMxHzPcmCf1q2fSdhQVcaKsFrtGRsdGfNk",
];
const MERCHANT_XMR_ADDRESS = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const BTC_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const PRICES: Record<string, string> = { xmr: "250", btc: "50000" };

let wallet: Server;
let walletUp = true;
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
      if (!walletUp || method !== "create_address") {
        res.writeHead(500);
        return res.end();
      }
      const index = nextIndex++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "0", result: { address: SUBADDRESSES[index % 2], address_index: index } }));
    });
  }).listen(0, "127.0.0.1");
  await once(wallet, "listening");
  process.env.MONERO_WALLET_RPC_URL = `http://127.0.0.1:${(wallet.address() as AddressInfo).port}`;

  const helpers = await import("../helpers/http-app.js");
  postJson = helpers.postJson;
  computeBlindIndex = (await import("../../src/security/blind-index.js")).computeBlindIndex;
  ({ baseUrl, db, stop } = await helpers.startTestApp({ getPrice: async (coin) => PRICES[coin] }));
});

after(async () => {
  await db.collection("invoices").deleteMany({ user_id: { $in: userIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await stop();
  await new Promise<void>((resolve) => wallet.close(() => resolve()));
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
  return apiKey;
}

const createInvoice = (apiKey: string, body: Record<string, unknown>) =>
  postJson(`${baseUrl}/invoices`, { amount: "25", ...body }, { merchant_key: apiKey });

const invoiceInDb = (invoiceId: string) => db.collection("invoices").findOne({ invoice_id: invoiceId });

describe("XMR invoices", () => {
  it("creates a fixed-coin XMR invoice whose deposit is a new subaddress of the platform wallet, with no key stored", async () => {
    walletUp = true;
    const apiKey = await merchant({ xmr: MERCHANT_XMR_ADDRESS });
    const index = nextIndex;

    const response = await createInvoice(apiKey, { crypto: "xmr", to_crypto: "xmr" });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const invoice = await invoiceInDb(response.body.data.invoiceId);
    assert.equal(invoice?.crypto, "xmr");
    assert.equal(invoice?.to_address, MERCHANT_XMR_ADDRESS);
    assert.equal(invoice?.address, SUBADDRESSES[index % 2]);
    assert.equal(invoice?.subaddress_index, index);
    assert.equal(invoice?.private?.private_key ?? undefined, undefined);
    assert.equal(invoice?.amount, "100000000000"); // $25 at $250/XMR = 0.1 XMR, 12 decimals
  });

  it("answers 503 and creates nothing when the platform wallet does not answer", async () => {
    walletUp = false;
    const apiKey = await merchant({ xmr: MERCHANT_XMR_ADDRESS });

    const response = await createInvoice(apiKey, { crypto: "xmr", to_crypto: "xmr" });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "DEPOSIT_UNAVAILABLE");
    assert.equal(await db.collection("invoices").countDocuments({ user_id: userIds.at(-1) }), 0);
    walletUp = true;
  });

  it("refuses payer-pays for XMR while no monerod is configured for the fee estimate", async () => {
    const apiKey = await merchant({ xmr: MERCHANT_XMR_ADDRESS });

    const response = await createInvoice(apiKey, { crypto: "xmr", to_crypto: "xmr", fee_paid_by_payer: true });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "PAYER_PAYS_NOT_SUPPORTED");
  });

  it("offers XMR on a merchant's-list invoice, and choosing it makes the subaddress deposit", async () => {
    const apiKey = await merchant({ xmr: MERCHANT_XMR_ADDRESS, btc: BTC_ADDRESS });

    const created = await createInvoice(apiKey, { mode: "merchant_list" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const invoiceId = created.body.data.invoiceId;
    assert.deepEqual([...(await invoiceInDb(invoiceId))!.offered_coins].sort(), ["btc", "xmr"]);

    walletUp = false;
    const unchosen = await invoiceInDb(invoiceId);
    const refused = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "xmr" });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, "DEPOSIT_UNAVAILABLE");
    const after = await invoiceInDb(invoiceId);
    assert.deepEqual(
      [after?.crypto, after?.address, after?.subaddress_index],
      [unchosen?.crypto, unchosen?.address, unchosen?.subaddress_index],
      "a refused choice must not lock the coin",
    );

    walletUp = true;
    const index = nextIndex;
    const chosen = await postJson(`${baseUrl}/pay/${invoiceId}/choose`, { crypto: "xmr" });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    const invoice = await invoiceInDb(invoiceId);
    assert.equal(invoice?.crypto, "xmr");
    assert.equal(invoice?.address, SUBADDRESSES[index % 2]);
    assert.equal(invoice?.subaddress_index, index);
    assert.equal(invoice?.amount, "100000000000");
  });
});
