import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { runWatcherPass, type WatcherPorts } from "../../src/invoice/invoice.watcher.js";
import { parseFeeRate, payerPaysAskedAmount, splitPayout } from "../../src/money/payout-split.js";

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
async function btcInvoice(fields: Record<string, unknown> = {}) {
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
    ...fields,
  });
  return { invoiceId, address };
}

const AFTER_EXPIRY = NOW + 26 * MINUTE; // created 5 minutes before NOW, lifetime 30

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

  it("never expires an invoice while the chain lookup is failing", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, "lookup fails"]]), AFTER_EXPIRY);

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "waiting");
  });

  it("counts a full payment that is there at the expiry check as on time", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, { received: AMOUNT, confirmed: 0n }]]), AFTER_EXPIRY);

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirming");
  });

  it("expires an underpaid invoice as partially paid, keeping what arrived", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, { received: 40_000n, confirmed: 40_000n }]]), AFTER_EXPIRY);

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.equal(invoice?.outcome, "partially_paid");
    assert.equal(invoice?.paid_amount, "40000");
    assert.ok(!paidOut.includes(invoiceId));
  });

  it("expires an unpaid invoice with no outcome to handle", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, { received: 0n, confirmed: 0n }]]), AFTER_EXPIRY);

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.ok(!invoice?.outcome);
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

describe("a merchant's-list invoice where the payer never picked a coin", () => {
  async function unchosenInvoice() {
    const invoiceId = randomUUID();
    invoiceIds.push(invoiceId);
    await db.collection("invoices").insertOne({
      invoice_id: invoiceId,
      user_id: randomUUID(),
      status: "waiting",
      mode: "merchant_list",
      offered_coins: ["btc"],
      crypto: "",
      amount: "0",
      amount_fiat: "2500",
      paid_amount: "0",
      address: "",
      lifetime: 30,
      timestamps: { created: NOW - 5 * MINUTE, waiting: NOW - 5 * MINUTE },
    });
    return invoiceId;
  }

  it("stays open during its lifetime", async () => {
    const invoiceId = await unchosenInvoice();

    await runWatcherPass(fakePorts(new Map()).ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "waiting");
  });

  it("expires when its lifetime is over", async () => {
    const invoiceId = await unchosenInvoice();

    await runWatcherPass(fakePorts(new Map(), AFTER_EXPIRY).ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.equal(invoice?.timestamps?.expired, AFTER_EXPIRY);
  });
});

describe("the merchant's underpaid tolerance", () => {
  it("accepts a payment short by no more than the tolerance (95 of 100 at 5%)", async () => {
    const { invoiceId, address } = await btcInvoice({ underpaid: 5 });
    const { ports } = fakePorts(new Map([[address, { received: 95_000n, confirmed: 95_000n }]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirmed");
  });

  it("refuses a payment one unit short of the tolerance", async () => {
    const { invoiceId, address } = await btcInvoice({ underpaid: 5 });
    const { ports } = fakePorts(new Map([[address, { received: 94_999n, confirmed: 94_999n }]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "underpaid");
  });

  it("rounds the accepted minimum up, never in the payer's favour", async () => {
    // 2.5% of 100,001 is 2,500.025: the payer must send at least 97,501.
    const amount = 100_001n;
    const short = await btcInvoice({ underpaid: 2.5, amount: amount.toString() });
    const enough = await btcInvoice({ underpaid: 2.5, amount: amount.toString() });
    const { ports } = fakePorts(
      new Map([
        [short.address, { received: 97_500n, confirmed: 97_500n }],
        [enough.address, { received: 97_501n, confirmed: 97_501n }],
      ]),
    );

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(short.invoiceId))?.status, "underpaid");
    assert.equal((await invoiceNow(enough.invoiceId))?.status, "confirmed");
  });

  it("asks for the full amount when there is no tolerance", async () => {
    const { invoiceId, address } = await btcInvoice({ underpaid: 0 });
    const { ports } = fakePorts(new Map([[address, { received: AMOUNT - 1n, confirmed: AMOUNT - 1n }]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "underpaid");
  });
});

describe("a payer-pays invoice", () => {
  // The merchant wants 100,000 sat; the network cost was estimated at 2,440
  // sat when the invoice was made; the fee rate is 5%.
  // asked = ceil((100,000 + 2,440) / 0.95) = ceil(107,831.58) = 107,832
  const BASE = 100_000n;
  const ESTIMATE = 2_440n;
  const FEE_RATE = parseFeeRate("0.05")!;
  const ASKED = 107_832n;

  async function payerPaysInvoice(fields: Record<string, unknown> = {}) {
    return await btcInvoice({
      fee_paid_by_payer: true,
      amount: BASE.toString(),
      asked_amount: ASKED.toString(),
      ...fields,
    });
  }

  /**
   * A payout port standing in for a chain adapter whose transaction really
   * costs `realNetworkCost`: it splits whatever the deposit holds by F1, as
   * every chain's payout does.
   */
  function settlingPorts(chain: Map<string, Totals>, realNetworkCost: bigint) {
    const addresses = new Map<string, string>();
    const merchantGot = new Map<string, bigint>();
    const { ports } = fakePorts(chain);
    return {
      merchantGot,
      track: (invoiceId: string, address: string) => addresses.set(invoiceId, address),
      ports: {
        ...ports,
        payOut: async (invoice) => {
          const held = chain.get(addresses.get(invoice.invoice_id)!);
          if (held === undefined || held === "lookup fails") return;
          const split = splitPayout({ received: held.confirmed, networkCost: realNetworkCost, feeRate: FEE_RATE });
          if (split !== undefined) merchantGot.set(invoice.invoice_id, split.merchantAmount);
        },
      } satisfies WatcherPorts,
    };
  }

  it("asks for an amount that pays the merchant the invoice amount at the estimated cost", () => {
    assert.equal(payerPaysAskedAmount({ invoiceAmount: BASE, estimatedNetworkCost: ESTIMATE, feeRate: FEE_RATE }), ASKED);
  });

  it("is paid by exactly the asked amount, and the merchant gets the invoice amount when the cost is as estimated", async () => {
    const { invoiceId, address } = await payerPaysInvoice();
    const s = settlingPorts(new Map([[address, { received: ASKED, confirmed: ASKED }]]), ESTIMATE);
    s.track(invoiceId, address);

    await runWatcherPass(s.ports);
    assert.equal((await invoiceNow(invoiceId))?.status, "confirmed");
    await runWatcherPass(s.ports);

    // fee = ceil(5,391.6) = 5,392; 107,832 − 5,392 − 2,440 = 100,000
    assert.equal(s.merchantGot.get(invoiceId), BASE);
  });

  it("is not paid by the invoice amount alone", async () => {
    const { invoiceId, address } = await payerPaysInvoice();
    const { ports } = fakePorts(new Map([[address, { received: BASE, confirmed: BASE }]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "underpaid");
  });

  it("applies the tolerance to the asked amount", async () => {
    // 1% of 107,832 is 1,078.32: at least 107,832 − 1,078 = 106,754
    const enough = await payerPaysInvoice({ underpaid: 1 });
    const short = await payerPaysInvoice({ underpaid: 1 });
    const chain = new Map<string, Totals>([
      [enough.address, { received: 106_754n, confirmed: 106_754n }],
      [short.address, { received: 106_753n, confirmed: 106_753n }],
    ]);
    const s = settlingPorts(chain, ESTIMATE);
    s.track(enough.invoiceId, enough.address);

    await runWatcherPass(s.ports);
    assert.equal((await invoiceNow(enough.invoiceId))?.status, "confirmed");
    assert.equal((await invoiceNow(short.invoiceId))?.status, "underpaid");
    await runWatcherPass(s.ports);

    // The tolerance is the merchant's: fee = ceil(5,337.7) = 5,338;
    // 106,754 − 5,338 − 2,440 = 98,976
    assert.equal(s.merchantGot.get(enough.invoiceId), 98_976n);
  });

  it("leaves the merchant the cost of a network fee above the estimate", async () => {
    const { invoiceId, address } = await payerPaysInvoice();
    const s = settlingPorts(new Map([[address, { received: ASKED, confirmed: ASKED }]]), ESTIMATE + 1_000n);
    s.track(invoiceId, address);

    await runWatcherPass(s.ports);
    await runWatcherPass(s.ports);

    // 107,832 − 5,392 − 3,440 = 99,000
    assert.equal(s.merchantGot.get(invoiceId), BASE - 1_000n);
  });

  it("gives the merchant the saving of a network fee below the estimate", async () => {
    const { invoiceId, address } = await payerPaysInvoice();
    const s = settlingPorts(new Map([[address, { received: ASKED, confirmed: ASKED }]]), ESTIMATE - 1_000n);
    s.track(invoiceId, address);

    await runWatcherPass(s.ports);
    await runWatcherPass(s.ports);

    // 107,832 − 5,392 − 1,440 = 101,000
    assert.equal(s.merchantGot.get(invoiceId), BASE + 1_000n);
  });

  it("checks a TON payment against the asked amount, less only the storage-fee allowance", async () => {
    // 5 TON invoice, 0.005 TON fee budget, 5%: asked 5,268,421,053 nanoton.
    // A 30-minute TON invoice allows ceil(30 × 75 / 60) = 38 nanoton short.
    const asked = 5_268_421_053n;
    const ton = { crypto: "ton", to_crypto: "ton", amount: "5000000000", asked_amount: asked.toString() };
    const paid = await payerPaysInvoice(ton);
    const baseOnly = await payerPaysInvoice(ton);
    const { ports } = fakePorts(
      new Map([
        [paid.address, { received: asked - 38n, confirmed: asked - 38n }],
        [baseOnly.address, { received: 5_000_000_000n, confirmed: 5_000_000_000n }],
      ]),
    );

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(paid.invoiceId))?.status, "confirmed");
    assert.equal((await invoiceNow(baseOnly.invoiceId))?.status, "underpaid");
  });
});
