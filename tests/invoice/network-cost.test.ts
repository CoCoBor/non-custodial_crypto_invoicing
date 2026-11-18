import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { estimatePayoutNetworkCost } from "../../src/invoice/network-cost.js";

// The real network-cost estimate behind payer-pays invoices. Blockbook is
// replaced by a stubbed fetch: no network.

const realFetch = globalThis.fetch;
let requested: string[] = [];

function blockbookAnswers(status: number, body: unknown) {
  requested = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the payout network-cost estimate", () => {
  it("prices a BTC payout of one payment to two outputs at Blockbook's 2-block fee rate", async () => {
    // 0.00012345 BTC/kB = 12,345 sat/kB. Size: 10 + 148 (one P2PKH input)
    // + 2 × (34 + 9) (two of the widest outputs) = 244 bytes.
    // 244 × 12,345 / 1,000 = 3,012.18 → 3,013 sat
    blockbookAnswers(200, { result: "0.00012345" });

    assert.equal(await estimatePayoutNetworkCost("btc"), 3_013n);
    assert.equal(requested.length, 1);
    assert.match(requested[0]!, /\/estimatefee\/2$/);
  });

  it("has no BTC estimate while Blockbook fails", async () => {
    blockbookAnswers(500, { error: "down" });

    assert.equal(await estimatePayoutNetworkCost("btc"), undefined);
  });

  it("prices an LTC payout the same way, at Blockbook's 2-block fee rate", async () => {
    // 0.00012345 LTC/kB = 12,345 litoshi/kB. Size: 8 + 1 + 1 + 148 (one
    // P2PKH input) + 2 × (8 + 1 + 34) = 244 bytes → 3,013 litoshi.
    blockbookAnswers(200, { result: "0.00012345" });

    assert.equal(await estimatePayoutNetworkCost("ltc"), 3_013n);
    assert.equal(requested.length, 1);
    assert.match(requested[0]!, /^https:\/\/ltcbook\.nownodes\.io\/api\/v2\/estimatefee\/2$/);
  });

  it("raises an LTC estimate below what nodes relay to the 1,000 litoshi/kB minimum", async () => {
    blockbookAnswers(200, { result: "0.00000997" });

    assert.equal(await estimatePayoutNetworkCost("ltc"), 244n);
  });

  it("has no LTC estimate while Blockbook fails", async () => {
    blockbookAnswers(500, { error: "down" });

    assert.equal(await estimatePayoutNetworkCost("ltc"), undefined);
  });

  it("uses the fee budget every TON payout charges", async () => {
    blockbookAnswers(500, {});

    assert.equal(await estimatePayoutNetworkCost("ton"), 5_000_000n);
    assert.equal(requested.length, 0);
  });

  it("prices a SOL payout at one signature plus the priority fee floor over its compute unit limit", async () => {
    // 5,000 lamports + 1,500 compute units × 50,000 micro-lamports = 5,075.
    blockbookAnswers(200, { jsonrpc: "2.0", id: 1, result: [{ slot: 1, prioritizationFee: 0 }] });

    assert.equal(await estimatePayoutNetworkCost("sol"), 5_075n);
    assert.equal(requested.length, 1);
    assert.match(requested[0]!, /^https:\/\/sol\.nownodes\.io/);
  });

  it("has no SOL estimate while the node fails", async () => {
    blockbookAnswers(500, {});

    assert.equal(await estimatePayoutNetworkCost("sol"), undefined);
  });

  it("has none for a coin a payer can't deposit yet", async () => {
    assert.equal(await estimatePayoutNetworkCost("usdtbsc"), "unsupported");
  });

  it("has none for XMR while no monerod is configured (MONERO_DAEMON_RPC_URL)", async () => {
    assert.equal(await estimatePayoutNetworkCost("xmr"), "unsupported");
  });
});
