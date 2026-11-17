import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import litecore from "bitcore-lib-ltc";

import { createApp } from "../../src/app.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";

// Needs a test database, e.g.
//   MONGODB_URI=mongodb://127.0.0.1:27018 MONGODB_DATABASE=merchant_test npm test
//
// The app may not reach the network: prices come from exchanges, so a request
// that passes address checks stops at "price unavailable" (503). That is how
// these tests tell "address accepted" from "address refused" (409).

const realFetch = globalThis.fetch;
const externalCalls: string[] = [];

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  externalCalls.push(url.hostname);
  throw new Error("network is disabled in tests");
};

let server: Server;
let baseUrl: string;
const merchantKeys: string[] = [];

before(async () => {
  await connectToMongoDb();
  server = createApp().listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  const db = await connectToMongoDb();
  await db.collection("users").deleteMany({ merchant_key: { $in: merchantKeys } });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await disconnectFromMongoDB();
  globalThis.fetch = realFetch;
});

/** A merchant whose only saved payout address is `address` for `asset`. */
async function merchantWithPayoutAddress(asset: string, address: string) {
  const merchantKey = randomUUID();
  merchantKeys.push(merchantKey);
  const db = await connectToMongoDb();
  await db.collection("users").insertOne({
    user_id: randomUUID(),
    merchant_key: merchantKey,
    merchant_fee: "0.005",
    payout_addresses: { [asset]: address },
  });
  return merchantKey;
}

async function createInvoice(
  merchantKey: string,
  toCrypto: string,
  extra: Record<string, unknown> = {},
) {
  const response = await realFetch(`${baseUrl}/invoices`, {
    method: "POST",
    headers: { "content-type": "application/json", merchant_key: merchantKey },
    body: JSON.stringify({ amount: "25", crypto: "btc", to_crypto: toCrypto, ...extra }),
  });
  const body = await response.json();
  return { status: response.status, code: body.error?.code ?? body.code };
}

// Every deposit this route creates is BTC, and the BTC payout can only pay
// out as btc or usdceth.
const VALID_AND_PAYABLE: [asset: string, address: string, label: string][] = [
  ["btc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "legacy"],
  ["btc", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "P2SH"],
  ["btc", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "bech32"],
  ["btc", "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", "taproot"],
  ["usdceth", "0x000000000000000000000000000000000000dEaD", "EVM"],
];

const VALID_NOT_PAYABLE_YET: [asset: string, address: string, label: string][] = [
  ["ltc", new litecore.PrivateKey().toAddress().toString(), "legacy"],
  ["eth", "0x000000000000000000000000000000000000dEaD", "checksummed"],
  ["usdteth", "0x000000000000000000000000000000000000dead", "lower case"],
  ["usdtbsc", "0x000000000000000000000000000000000000dEaD", "BSC token"],
  ["bsc", "0x000000000000000000000000000000000000dEaD", "BNB"],
  ["sol", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "base58"],
  ["usdcsol", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "SPL token"],
  ["ton", "UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_", "non-bounceable"],
  ["usdtton", "UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_", "jetton"],
];

const WRONG_CHAIN: [asset: string, address: string, label: string][] = [
  ["sol", "0x000000000000000000000000000000000000dEaD", "an Ethereum address for SOL"],
  ["ton", "0x000000000000000000000000000000000000dEaD", "an Ethereum address for TON"],
  ["ltc", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "a Bitcoin address for LTC"],
  ["eth", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "a Solana address for ETH"],
  ["btc", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "a testnet Bitcoin address"],
  ["btc", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv", "a Bitcoin address with a bad checksum"],
  ["eth", "0x0000000000000000000000000000000000000000", "the Ethereum zero address"],
];

describe("creating an invoice checks the payout address for the coin's own chain", () => {
  for (const [asset, address, label] of VALID_AND_PAYABLE) {
    it(`accepts a ${label} ${asset} address`, async () => {
      const merchantKey = await merchantWithPayoutAddress(asset, address);
      const result = await createInvoice(merchantKey, asset);

      assert.equal(result.status, 503, `refused with ${result.code}`);
      assert.equal(result.code, "PRICE_UNAVAILABLE");
    });
  }

  // The address passes its chain's check, but a BTC deposit can't be paid out
  // as this coin yet: creating the invoice would strand the payer's BTC.
  for (const [asset, address, label] of VALID_NOT_PAYABLE_YET) {
    it(`accepts a ${label} ${asset} address but refuses the invoice: no payout from BTC yet`, async () => {
      const merchantKey = await merchantWithPayoutAddress(asset, address);
      const result = await createInvoice(merchantKey, asset);

      assert.equal(result.status, 409);
      assert.equal(result.code, "PAYOUT_NOT_SUPPORTED");
    });
  }

  for (const [asset, address, label] of WRONG_CHAIN) {
    it(`refuses ${label}`, async () => {
      const merchantKey = await merchantWithPayoutAddress(asset, address);
      const result = await createInvoice(merchantKey, asset);

      assert.equal(result.status, 409);
      assert.equal(result.code, "PAYOUT_ADDRESS_REQUIRED");
    });
  }

  it("refuses a coin the platform does not list", async () => {
    const merchantKey = await merchantWithPayoutAddress("doge", "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L");
    const result = await createInvoice(merchantKey, "doge");

    assert.equal(result.status, 400);
    assert.equal(result.code, "INVALID_REQUEST");
  });

  for (const [asset, address] of [
    ["usdttrx", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
    ["xmr", "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A"],
  ]) {
    it(`says ${asset} payouts are not supported yet, rather than blaming the address`, async () => {
      const merchantKey = await merchantWithPayoutAddress(asset, address);
      const result = await createInvoice(merchantKey, asset);

      assert.equal(result.status, 409);
      assert.equal(result.code, "PAYOUT_NOT_SUPPORTED");
    });
  }

  for (const underpaid of [0, 2.5, 5]) {
    it(`accepts an underpaid tolerance of ${underpaid}%`, async () => {
      const merchantKey = await merchantWithPayoutAddress("btc", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
      const result = await createInvoice(merchantKey, "btc", { underpaid });

      assert.equal(result.code, "PRICE_UNAVAILABLE", `refused with ${result.code}`);
    });
  }

  for (const underpaid of [5.01, -1, 0.123, "5"]) {
    it(`refuses an underpaid tolerance of ${JSON.stringify(underpaid)}`, async () => {
      const merchantKey = await merchantWithPayoutAddress("btc", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
      const result = await createInvoice(merchantKey, "btc", { underpaid });

      assert.equal(result.status, 400);
      assert.equal(result.code, "INVALID_REQUEST");
    });
  }

  it("never reaches the network for an address check", () => {
    // Only price lookups may have been attempted (and refused).
    assert.ok(!externalCalls.some((host) => host.includes("nownodes")));
  });
});
