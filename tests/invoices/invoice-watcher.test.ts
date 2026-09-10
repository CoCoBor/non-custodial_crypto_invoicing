import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { type Db, ObjectId } from "mongodb";

import type { AddressActivity } from "../../src/chains/bitcoin/blockbook.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import {
  INVOICES_COLLECTION,
  type InvoiceDocument,
  type InvoiceStatus,
} from "../../src/invoices/invoice.model.js";
import { runWatcherPass } from "../../src/invoices/invoice-watcher.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const IN_AN_HOUR = new Date("2026-08-29T13:00:00.000Z");
const AN_HOUR_AGO = new Date("2026-08-29T11:00:00.000Z");
const A_WEEK_AGO = new Date("2026-08-22T12:00:00.000Z");

const AMOUNT = 500_000;

let database: Db;
const accountId = new ObjectId();

/** Addresses the fake provider knows about, and what it reports for them. */
let activityByAddress: Map<string, AddressActivity>;
let addressesFetched: string[];

const fakeFetch = async (address: string) => {
  addressesFetched.push(address);

  return activityByAddress.get(address);
};

function activity(confirmedSatoshi: number, pendingSatoshi = 0): AddressActivity {
  return {
    address: "unused",
    confirmedSatoshi,
    pendingSatoshi,
    unconfirmedTxCount: pendingSatoshi > 0 ? 1 : 0,
  };
}

let addressCounter = 0;

async function seedInvoice(
  overrides: Partial<InvoiceDocument> = {},
): Promise<InvoiceDocument> {
  addressCounter += 1;
  const address = `bc1qtest${String(addressCounter).padStart(6, "0")}`;

  const document = {
    _id: new ObjectId(),
    publicId: `inv_TEST${addressCounter}`,
    accountId,
    status: "waiting" as InvoiceStatus,
    amountSatoshi: AMOUNT,
    paidSatoshi: 0,
    addressIndex: addressCounter,
    address,
    underpaidTolerancePercent: 0,
    lifetimeMinutes: 60,
    expiresAt: IN_AN_HOUR,
    timestamps: {
      created: AN_HOUR_AGO,
      waiting: AN_HOUR_AGO,
      confirming: null,
      confirmed: null,
      expired: null,
    },
    createdAt: AN_HOUR_AGO,
    updatedAt: AN_HOUR_AGO,
    ...overrides,
  } as InvoiceDocument;

  await database.collection<InvoiceDocument>(INVOICES_COLLECTION).insertOne(document);

  return document;
}

function reload(id: ObjectId) {
  return database
    .collection<InvoiceDocument>(INVOICES_COLLECTION)
    .findOne({ _id: id });
}

before(async () => {
  database = await connectToMongoDb();
  await ensureIndexes(database);
});

// runWatcherPass sweeps the whole collection, so these tests have to own the
// whole collection. Scoping cleanup to one accountId lets a stray invoice from
// another file — or from a run that crashed before its cleanup — join the pass
// and skew the counts.
beforeEach(async () => {
  await database.collection(INVOICES_COLLECTION).deleteMany({});
  activityByAddress = new Map();
  addressesFetched = [];
});

after(async () => {
  await database.collection(INVOICES_COLLECTION).deleteMany({});
  await disconnectFromMongoDB();
});

describe("nothing has been paid", () => {
  it("leaves a live invoice waiting", async () => {
    const invoice = await seedInvoice();
    activityByAddress.set(invoice.address, activity(0));

    await runWatcherPass(database, fakeFetch, NOW);

    assert.equal((await reload(invoice._id))?.status, "waiting");
  });

  it("expires an invoice whose deadline has passed", async () => {
    const invoice = await seedInvoice({ expiresAt: AN_HOUR_AGO });
    activityByAddress.set(invoice.address, activity(0));

    await runWatcherPass(database, fakeFetch, NOW);

    const updated = await reload(invoice._id);
    assert.equal(updated?.status, "expired");
    assert.ok(updated?.timestamps.expired instanceof Date);
  });
});

describe("a payment arrives", () => {
  it("confirms an exactly paid invoice", async () => {
    const invoice = await seedInvoice();
    activityByAddress.set(invoice.address, activity(AMOUNT));

    await runWatcherPass(database, fakeFetch, NOW);

    const updated = await reload(invoice._id);
    assert.equal(updated?.status, "confirmed");
    assert.equal(updated?.paidSatoshi, AMOUNT);
    assert.ok(updated?.timestamps.confirmed instanceof Date);
  });

  it("records an overpayment in full", async () => {
    const invoice = await seedInvoice();
    activityByAddress.set(invoice.address, activity(AMOUNT + 9_000));

    await runWatcherPass(database, fakeFetch, NOW);

    const updated = await reload(invoice._id);
    assert.equal(updated?.status, "confirmed");
    assert.equal(updated?.paidSatoshi, AMOUNT + 9_000);
  });

  it("marks a short payment underpaid and remembers how much arrived", async () => {
    const invoice = await seedInvoice();
    activityByAddress.set(invoice.address, activity(300_000));

    await runWatcherPass(database, fakeFetch, NOW);

    const updated = await reload(invoice._id);
    assert.equal(updated?.status, "underpaid");
    assert.equal(updated?.paidSatoshi, 300_000);
  });

  it("reports confirming while the payment is still in the mempool", async () => {
    const invoice = await seedInvoice();
    activityByAddress.set(invoice.address, activity(0, AMOUNT));

    await runWatcherPass(database, fakeFetch, NOW);

    const updated = await reload(invoice._id);
    assert.equal(updated?.status, "confirming");
    assert.ok(updated?.timestamps.confirming instanceof Date);
  });

  it("settles an invoice that expired before the money arrived", async () => {
    const invoice = await seedInvoice({
      status: "expired",
      expiresAt: AN_HOUR_AGO,
      timestamps: {
        created: AN_HOUR_AGO,
        waiting: AN_HOUR_AGO,
        confirming: null,
        confirmed: null,
        expired: AN_HOUR_AGO,
      },
    });
    activityByAddress.set(invoice.address, activity(AMOUNT));

    await runWatcherPass(database, fakeFetch, NOW);

    assert.equal((await reload(invoice._id))?.status, "confirmed");
  });

  it("falls back to waiting if a mempool payment disappears", async () => {
    const invoice = await seedInvoice({ status: "confirming", paidSatoshi: AMOUNT });
    activityByAddress.set(invoice.address, activity(0, 0));

    await runWatcherPass(database, fakeFetch, NOW);

    const updated = await reload(invoice._id);
    assert.equal(
      updated?.status,
      "waiting",
      "an unconfirmed transaction can be replaced or dropped — the invoice must follow",
    );
    assert.equal(updated?.paidSatoshi, 0);
  });
});

describe("which invoices get checked", () => {
  it("skips invoices that are already confirmed", async () => {
    const invoice = await seedInvoice({
      status: "confirmed",
      paidSatoshi: AMOUNT,
    });

    await runWatcherPass(database, fakeFetch, NOW);

    assert.ok(
      !addressesFetched.includes(invoice.address),
      "a confirmed invoice is finished — checking it again is wasted provider quota",
    );
  });

  it("stops checking invoices that expired long ago", async () => {
    const invoice = await seedInvoice({
      status: "expired",
      expiresAt: A_WEEK_AGO,
    });

    await runWatcherPass(database, fakeFetch, NOW);

    assert.ok(
      !addressesFetched.includes(invoice.address),
      "watching every expired invoice forever is unbounded work",
    );
  });

  it("still checks an invoice that expired recently", async () => {
    const invoice = await seedInvoice({
      status: "expired",
      expiresAt: AN_HOUR_AGO,
    });
    activityByAddress.set(invoice.address, activity(0));

    await runWatcherPass(database, fakeFetch, NOW);

    assert.ok(addressesFetched.includes(invoice.address));
  });

  it("checks every live invoice in one pass", async () => {
    const first = await seedInvoice();
    const second = await seedInvoice();
    activityByAddress.set(first.address, activity(AMOUNT));
    activityByAddress.set(second.address, activity(0));

    const result = await runWatcherPass(database, fakeFetch, NOW);

    assert.equal(result.checked, 2);
    assert.equal((await reload(first._id))?.status, "confirmed");
    assert.equal((await reload(second._id))?.status, "waiting");
  });
});

describe("robustness", () => {
  it("leaves an invoice untouched when the provider fails", async () => {
    const invoice = await seedInvoice();
    // no entry in the map, so the fake returns undefined

    await runWatcherPass(database, fakeFetch, NOW);

    const updated = await reload(invoice._id);
    assert.equal(updated?.status, "waiting");
    assert.equal(updated?.paidSatoshi, 0);
  });

  it("keeps going after one address fails", async () => {
    const broken = await seedInvoice();
    const fine = await seedInvoice();
    activityByAddress.set(fine.address, activity(AMOUNT));

    await runWatcherPass(database, fakeFetch, NOW);

    assert.equal((await reload(broken._id))?.status, "waiting");
    assert.equal(
      (await reload(fine._id))?.status,
      "confirmed",
      "one failing lookup must not stop the whole pass",
    );
  });

  it("produces the same result when run twice", async () => {
    const invoice = await seedInvoice();
    activityByAddress.set(invoice.address, activity(AMOUNT));

    await runWatcherPass(database, fakeFetch, NOW);
    const afterFirst = await reload(invoice._id);

    await runWatcherPass(database, fakeFetch, NOW);
    const afterSecond = await reload(invoice._id);

    assert.equal(afterSecond?.status, "confirmed");
    assert.equal(
      afterSecond?.timestamps.confirmed?.getTime(),
      afterFirst?.timestamps.confirmed?.getTime(),
      "a timestamp records when something first happened, not when it was last checked",
    );
  });

  it("reports how much it did", async () => {
    const paid = await seedInvoice();
    const unpaid = await seedInvoice();
    activityByAddress.set(paid.address, activity(AMOUNT));
    activityByAddress.set(unpaid.address, activity(0));

    const result = await runWatcherPass(database, fakeFetch, NOW);

    assert.equal(result.checked, 2);
    assert.equal(result.updated, 1, "only the invoice that actually changed counts");
  });
});

function invoices() {
  return database.collection<InvoiceDocument>(INVOICES_COLLECTION);
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement statuses
//
// `processing`, `completed` and `failed` are not observations — they record
// that the platform acted. The watcher must never write over them: a settled
// invoice pushed back to "confirmed" can be claimed by settlement a second
// time, and a second claim is a second broadcast of the same coins.
// ─────────────────────────────────────────────────────────────────────────────

describe("settled invoices", () => {
  for (const status of ["processing", "completed", "failed", "cancelled"] as const) {
    it(`never re-reads a ${status} invoice, so a settled invoice costs no provider call`, async () => {
      const invoice = await seedInvoice({ status, paidSatoshi: AMOUNT });
      activityByAddress.set(invoice.address, activity(AMOUNT));

      const result = await runWatcherPass(database, fakeFetch, NOW);

      assert.equal(
        addressesFetched.includes(invoice.address),
        false,
        `a ${status} invoice was fetched from the provider`,
      );
      assert.equal(result.checked, 0);
    });

    it(`leaves a ${status} invoice untouched`, async () => {
      const invoice = await seedInvoice({ status, paidSatoshi: AMOUNT });
      activityByAddress.set(invoice.address, activity(AMOUNT));

      await runWatcherPass(database, fakeFetch, NOW);

      const after = await invoices().findOne({ _id: invoice._id });
      assert.equal(after?.status, status);
    });
  }

  // The one that matters. The query runs at the start of the pass; the write
  // happens after a network call per invoice. Everything that changed in
  // between is invisible to a filter applied at read time.
  it("cannot resurrect an invoice that settlement claimed mid-pass", async () => {
    const invoice = await seedInvoice({ status: "confirming", paidSatoshi: 0 });
    activityByAddress.set(invoice.address, activity(AMOUNT));

    // Settlement claims the invoice while the watcher is waiting on the
    // provider — exactly the window between the read and the write.
    const racingFetch = async (address: string) => {
      await invoices().updateOne(
        { _id: invoice._id },
        { $set: { status: "processing" } },
      );

      return activityByAddress.get(address);
    };

    await runWatcherPass(database, racingFetch, NOW);

    const after = await invoices().findOne({ _id: invoice._id });
    assert.equal(
      after?.status,
      "processing",
      "the watcher overwrote a settled status; settlement can now claim it twice",
    );
  });

  it("still lets settlement claim a confirmed invoice, which is its input", async () => {
    // `confirmed` is terminal for the watcher but not for settlement, so it
    // must not be lumped in with the settled statuses.
    const invoice = await seedInvoice({ status: "confirmed", paidSatoshi: AMOUNT });

    const claimed = await invoices().findOneAndUpdate(
      { _id: invoice._id, status: "confirmed" },
      { $set: { status: "processing" } },
      { returnDocument: "after" },
    );

    assert.equal(claimed?.status, "processing");
  });
});
