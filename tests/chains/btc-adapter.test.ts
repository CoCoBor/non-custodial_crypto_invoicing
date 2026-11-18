import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import bitcore from "bitcore-lib";

import type { PayoutCheckpoint, PayoutRequest } from "../../src/chains/adapter.js";
import { createBtcAdapter } from "../../src/chains/btc.js";
import { parseFeeRate } from "../../src/money/payout-split.js";

// The BTC chain adapter's payout steps, with Blockbook stubbed. Signing is
// real (bitcore); nothing reaches a node. The Blockbook replies are written
// in the shapes the code already parses, not recorded from a node: this
// proves the save-before-broadcast order and the proof, not Blockbook's
// format. A regtest node (ticket 16) is what proves the chain side.

const PLATFORM = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"; // P2WPKH, 22-byte script
const MERCHANT = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"; // P2PKH, 25-byte script
const FEE_RATE_PER_KB = 10_000n; // sat/kB, as Blockbook's "0.0001" BTC/kB
const btc = createBtcAdapter({ platformAddress: PLATFORM });

type Chain = {
  utxos: { txid: string; vout: number; value: string; confirmations: number }[];
  /** Confirmations per txid; a txid not here is unknown to the node (404). */
  known: Map<string, number>;
  events: string[];
  broadcast: string[];
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function blockbook(chain: Chain) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "/estimatefee/2") return json({ result: "0.0001" });
    if (path.startsWith("/utxo/")) return json(chain.utxos);
    if (path === "/sendtx/" && init?.method === "POST") {
      const hex = String(init.body);
      chain.events.push("broadcast");
      chain.broadcast.push(hex);
      return json({ result: new bitcore.Transaction(hex).id });
    }
    if (path.startsWith("/tx/")) {
      const txid = path.slice("/tx/".length);
      const confirmations = chain.known.get(txid);
      return confirmations === undefined ? json({ error: "not found" }, 400) : json({ txid, confirmations });
    }
    throw new Error(`unexpected Blockbook call ${path}`);
  }) as typeof fetch;
}

function txid(name: string) {
  return createHash("sha256").update(name).digest("hex");
}

/** A fresh deposit holding `amounts` in confirmed outputs, and a request builder. */
async function fundedDeposit(amounts: bigint[], fields: Partial<PayoutRequest> = {}) {
  const deposit = await btc.newDeposit();
  const chain: Chain = {
    utxos: amounts.map((amount, i) => ({ txid: txid(`${deposit.address}-${i}`), vout: 0, value: amount.toString(), confirmations: 3 })),
    known: new Map(),
    events: [],
    broadcast: [],
  };
  blockbook(chain);
  const saved: PayoutCheckpoint[] = [];
  let allowSave = true;
  const request = (checkpoint?: PayoutCheckpoint): PayoutRequest => ({
    depositAddress: deposit.address,
    depositKey: deposit.key,
    destination: MERCHANT,
    destinationKind: "merchant_payout",
    receiveAsset: "btc",
    feeRate: parseFeeRate("0.05")!,
    minimumAmount: amounts.reduce((a, b) => a + b, 0n),
    checkpoint,
    saveCheckpoint: async (next) => {
      chain.events.push("save");
      if (!allowSave) return false;
      saved.push(next);
      return true;
    },
    ...fields,
  });
  return { deposit, chain, saved, request, refuseSaves: () => (allowSave = false) };
}

// One P2PKH input, outputs to MERCHANT (25-byte script) and PLATFORM (22):
// 10 + 148 + (25 + 9) + (22 + 9) = 223 bytes; 223 × 10,000 / 1,000 = 2,230 sat.
// 100,000 sat at 5%: platform 5,000; merchant 100,000 − 5,000 − 2,230 = 92,770.
const RECEIVED = 100_000n;
const NETWORK_COST = 2_230n;
const PLATFORM_FEE = 5_000n;
const MERCHANT_AMOUNT = 92_770n;

describe("a BTC payout through the adapter", () => {
  it("signs, saves the transaction, and only then broadcasts it", async () => {
    const d = await fundedDeposit([RECEIVED]);

    const result = await btc.payout(d.request());

    assert.equal(result.status, "pending");
    assert.deepEqual(d.chain.events, ["save", "broadcast"]);
    const [checkpoint] = d.saved;
    assert.ok(checkpoint);
    const id = new bitcore.Transaction(checkpoint.state).id;
    assert.deepEqual(checkpoint.plan, {
      transfers: [
        { kind: "merchant_payout", to: MERCHANT, amount: MERCHANT_AMOUNT, txid: id },
        { kind: "platform_fee", to: PLATFORM, amount: PLATFORM_FEE, txid: id },
      ],
      platformFee: PLATFORM_FEE,
      networkCost: NETWORK_COST,
    });
    assert.deepEqual(d.chain.broadcast, [checkpoint.state]);
  });

  it("broadcasts nothing when another run saved first", async () => {
    const d = await fundedDeposit([RECEIVED]);
    d.refuseSaves();

    const result = await btc.payout(d.request());

    assert.equal(result.status, "pending");
    assert.deepEqual(d.chain.broadcast, []);
  });

  it("broadcasts the same saved transaction again while the node does not know it", async () => {
    const d = await fundedDeposit([RECEIVED]);
    await btc.payout(d.request());

    const result = await btc.payout(d.request(d.saved[0]));

    assert.equal(result.status, "pending");
    assert.equal(d.saved.length, 1, "signed a second transaction");
    assert.deepEqual(d.chain.broadcast, [d.saved[0]!.state, d.saved[0]!.state]);
  });

  it("waits for the first confirmation", async () => {
    const d = await fundedDeposit([RECEIVED]);
    await btc.payout(d.request());
    d.chain.known.set(new bitcore.Transaction(d.saved[0]!.state).id, 0);

    const result = await btc.payout(d.request(d.saved[0]));

    assert.equal(result.status, "pending");
    assert.equal(d.chain.broadcast.length, 1);
  });

  it("proves the payout from the confirmed transaction's own outputs", async () => {
    const d = await fundedDeposit([RECEIVED]);
    await btc.payout(d.request());
    const id = new bitcore.Transaction(d.saved[0]!.state).id;
    d.chain.known.set(id, 1);

    const result = await btc.payout(d.request(d.saved[0]));

    assert.deepEqual(result, {
      status: "paid",
      transfers: [
        { kind: "merchant_payout", to: MERCHANT, amount: MERCHANT_AMOUNT, txid: id },
        { kind: "platform_fee", to: PLATFORM, amount: PLATFORM_FEE, txid: id },
      ],
    });
  });

  it("spends every payment in one transaction", async () => {
    const d = await fundedDeposit([60_000n, 40_000n]);

    await btc.payout(d.request());

    const tx = new bitcore.Transaction(d.saved[0]!.state);
    assert.equal(tx.inputs.length, 2);
    // A second input adds 148 bytes: 371 bytes, 3,710 sat.
    assert.equal(d.saved[0]!.plan.networkCost, 3_710n);
    assert.equal(d.saved[0]!.plan.transfers[0]!.amount, RECEIVED - PLATFORM_FEE - 3_710n);
  });

  it("sends no platform transfer at a 0% fee", async () => {
    const d = await fundedDeposit([RECEIVED], { feeRate: 0n });

    await btc.payout(d.request());

    assert.deepEqual(d.saved[0]!.plan.transfers.map((t) => t.kind), ["merchant_payout"]);
    assert.equal(d.saved[0]!.plan.platformFee, 0n);
  });

  it("charges the fee only on money that has not paid it yet, and sends no platform transfer when none is due", async () => {
    // 5% of (100,000 − 60,000) = 2,000; merchant 100,000 − 2,000 − 2,230 = 95,770.
    const part = await fundedDeposit([RECEIVED], { destinationKind: "refund_route", feeExempt: 60_000n });
    await btc.payout(part.request());
    assert.equal(part.saved[0]!.plan.platformFee, 2_000n);
    assert.equal(part.saved[0]!.plan.transfers[0]!.amount, 95_770n);

    const all = await fundedDeposit([RECEIVED], { destinationKind: "refund_route", feeExempt: RECEIVED });
    await btc.payout(all.request());
    assert.deepEqual(all.saved[0]!.plan.transfers.map((t) => t.kind), ["refund_route"]);
    assert.equal(all.saved[0]!.plan.platformFee, 0n);
  });

  it("waits while the spendable outputs are below the minimum", async () => {
    const d = await fundedDeposit([RECEIVED]);

    const result = await btc.payout({ ...d.request(), minimumAmount: RECEIVED + 1n });

    assert.equal(result.status, "pending");
    assert.deepEqual(d.chain.events, []);
  });

  it("says too small when the fees would take it all", async () => {
    const d = await fundedDeposit([2_000n]);

    const result = await btc.payout(d.request());

    assert.equal(result.status, "too_small");
    assert.deepEqual(d.chain.events, []);
  });

  it("stops, saying where the money is, for a destination that is not a mainnet address", async () => {
    const d = await fundedDeposit([RECEIVED], { destination: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" });

    const result = await btc.payout(d.request());

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.ok(result.message.includes(`all funds are still at deposit address ${d.deposit.address}`));
    assert.deepEqual(d.chain.events, []);
  });

  it("refuses to run with a platform address that is not a mainnet address", async () => {
    const d = await fundedDeposit([RECEIVED]);
    const misconfigured = createBtcAdapter({ platformAddress: "bc1qfake" });

    await assert.rejects(misconfigured.payout(d.request()), /Platform BTC address/);
  });
});
