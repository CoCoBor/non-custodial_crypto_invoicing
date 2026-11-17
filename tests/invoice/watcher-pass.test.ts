import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { runWatcherPass, type WatcherPorts } from "../../src/invoice/invoice.watcher.js";

// One watcher pass, with the clock, the chain and the payout faked.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const NOW = Date.parse("2026-11-17T12:00:00Z");
const MINUTE = 60_000;
const AMOUNT = 100_000n; // satoshi the invoice asks for

let db: Db;
const invoiceIds: string[] = [];

before(async () => {
  db = await connectToMongoDb();
});

after(async () => {
  await db.collection("invoices").deleteMany({ invoice_id: { $in: invoiceIds } });
  await disconnectFromMongoDB();
});

/** A BTC invoice created 5 minutes ago with a 30-minute lifetime. */
async function btcInvoice() {
  const invoiceId = randomUUID();
  invoiceIds.push(invoiceId);
  const address = `deposit-${invoiceId}`;
  await db.collection("invoices").insertOne({
    invoice_id: invoiceId,
    user_id: randomUUID(),
    status: "waiting",
    crypto: "btc",
    to_crypto: "btc",
    amount: AMOUNT.toString(),
    amount_fiat: "2500",
    paid_amount: "0",
    address,
    lifetime: 30,
    timestamps: { created: NOW - 5 * MINUTE, waiting: NOW - 5 * MINUTE },
  });
  return { invoiceId, address };
}

type Totals = { received: bigint; confirmed: bigint } | "lookup fails";

/** Fake ports: `chain` says what each deposit address has received. */
function fakePorts(chain: Map<string, Totals>, now = NOW) {
  const paidOut: string[] = [];
  const ports: WatcherPorts = {
    now: () => now,
    getPaymentTotals: async (_crypto, address) => {
      const totals = chain.get(address);
      if (totals === undefined || totals === "lookup fails") return undefined;
      return { receivedAmount: totals.received, confirmedAmount: totals.confirmed };
    },
    payOut: async (invoice) => {
      paidOut.push(invoice.invoice_id);
    },
  };
  return { ports, paidOut };
}

async function invoiceNow(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

describe("a watcher pass over a fixed-coin BTC invoice", () => {
  it("keeps waiting while nothing has been paid", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, { received: 0n, confirmed: 0n }]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "waiting");
    assert.ok(!paidOut.includes(invoiceId));
  });

  it("marks a full but unconfirmed payment as confirming, and pays nothing out", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, { received: AMOUNT, confirmed: 0n }]]));

    await runWatcherPass(ports);
    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirming");
    assert.ok(!paidOut.includes(invoiceId));
  });

  it("confirms a confirmed payment, then pays it out on the next pass", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, { received: AMOUNT, confirmed: AMOUNT }]]));

    await runWatcherPass(ports);
    const afterFirst = await invoiceNow(invoiceId);
    assert.equal(afterFirst?.status, "confirmed");
    assert.equal(afterFirst?.paid_amount, AMOUNT.toString());
    assert.equal(afterFirst?.timestamps?.confirmed, NOW);
    assert.ok(!paidOut.includes(invoiceId), "paid out in the same pass it was confirmed");

    await runWatcherPass(ports);
    assert.deepEqual(paidOut.filter((id) => id === invoiceId), [invoiceId]);
  });

  it("treats an overpayment as paid", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, { received: AMOUNT + 50_000n, confirmed: AMOUNT + 50_000n }]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirmed");
  });

  it("records a partial payment as underpaid", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, { received: 40_000n, confirmed: 40_000n }]]));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "underpaid");
    assert.equal(invoice?.paid_amount, "40000");
    assert.ok(!paidOut.includes(invoiceId));
  });

  it("expires an unpaid invoice once its lifetime is over, and never pays it out", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(
      new Map([[address, { received: 0n, confirmed: 0n }]]),
      NOW + 26 * MINUTE, // created 5 minutes before NOW, lifetime 30
    );

    await runWatcherPass(ports);
    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.equal(invoice?.timestamps?.expired, NOW + 26 * MINUTE);
    assert.ok(!paidOut.includes(invoiceId));
  });

  it("changes nothing when the chain lookup fails", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, "lookup fails"]]));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "waiting");
    assert.equal(invoice?.paid_amount, "0");
  });

  it("keeps going when one invoice's payout throws", async () => {
    const first = await btcInvoice();
    const second = await btcInvoice();
    await db.collection("invoices").updateMany(
      { invoice_id: { $in: [first.invoiceId, second.invoiceId] } },
      { $set: { status: "confirmed" } },
    );
    const attempted: string[] = [];
    const ports: WatcherPorts = {
      now: () => NOW,
      getPaymentTotals: async () => undefined,
      payOut: async (invoice) => {
        attempted.push(invoice.invoice_id);
        if (invoice.invoice_id === first.invoiceId) throw new Error("node down");
      },
    };

    await runWatcherPass(ports);

    assert.ok(attempted.includes(first.invoiceId) && attempted.includes(second.invoiceId));
  });
});
