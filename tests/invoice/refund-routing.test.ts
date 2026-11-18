import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import type {
  ChainAdapter,
  ChainPayment,
  PayoutRequest,
  PayoutResult,
} from "../../src/chains/adapter.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { runWatcherPass, type WatcherPorts } from "../../src/invoice/invoice.watcher.js";
import { unusedSwap } from "../helpers/fake-swap.js";
import { parseFeeRate, splitPayout } from "../../src/money/payout-split.js";
import { openSecret, sealSecret } from "../../src/security/secret-envelope.js";

// Closed invoices: the 7-day watch, refund routing and "too small to
// forward", through one watcher pass with the chain faked at the registry
// seam. The fake chain sweeps the whole deposit on payout, as BTC and TON do.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const NOW = Date.parse("2026-11-17T12:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
const CREATED = NOW - 5 * MINUTE;
const EXPIRES_AT = NOW + 25 * MINUTE; // lifetime 30 minutes
const NETWORK_COST = 1_000n;
const FEE_RATE = parseFeeRate("0.05")!;

const REFUND = "merchant-refund";
const PAYOUT = "merchant-payout";
const PLATFORM = "platform-wallet";

let db: Db;
const invoiceIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  db = await connectToMongoDb();
});

after(async () => {
  await db.collection("invoices").deleteMany({ invoice_id: { $in: invoiceIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await disconnectFromMongoDB();
});

function sealedKey() {
  return {
    keyVersion: 1,
    initialisationVector: randomBytes(12),
    authenticationTag: randomBytes(16),
    ciphertext: randomBytes(32),
  };
}

async function merchant(addresses: { refund?: string; payout?: string } = { refund: REFUND, payout: PAYOUT }) {
  const userId = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    merchant_fee: "0.05",
    refund_addresses: { btc: addresses.refund ?? "" },
    payout_addresses: { btc: addresses.payout ?? "" },
  });
  return userId;
}

type Closed = "expired" | "cancelled" | "completed";

const CLOSED_AT: Record<Closed, number> = {
  expired: EXPIRES_AT,
  cancelled: NOW,
  completed: NOW,
};

/** A BTC invoice that closed at CLOSED_AT[status], watched for 7 days from then. */
async function closedInvoice(status: Closed, userId: string, fields: Record<string, unknown> = {}) {
  const invoiceId = randomUUID();
  invoiceIds.push(invoiceId);
  const address = `deposit-${invoiceId}`;
  const closedAt = CLOSED_AT[status];
  await db.collection("invoices").insertOne({
    invoice_id: invoiceId,
    user_id: userId,
    status,
    crypto: "btc",
    to_crypto: "btc",
    to_address: PAYOUT,
    amount: "100000",
    amount_fiat: "2500",
    paid_amount: "0",
    address,
    lifetime: 30,
    fee_rate: "0.05",
    timestamps: { created: CREATED, waiting: CREATED, [status]: closedAt },
    watch_until: closedAt + WEEK,
    private: { private_key: sealedKey() },
    payments: [],
    transfers: [],
    ...fields,
  });
  return { invoiceId, address, closedAt };
}

const A_PAID = { txid: "tx-on-time", amount: "100000", first_seen_at: NOW - MINUTE, confirmations: 1, on_time: true };

/**
 * A completed invoice whose merchant payout swept `swept` from the deposit:
 * 100,000 received, 5,000 platform fee, 1,000 network cost.
 */
async function completedInvoice(userId: string, fields: Record<string, unknown> = {}) {
  return await closedInvoice("completed", userId, {
    paid_amount: "100000",
    payments: [A_PAID],
    transfers: [
      { kind: "merchant_payout", to: PAYOUT, amount: "94000", txid: "payout-0", status: "confirmed" },
      { kind: "platform_fee", to: PLATFORM, amount: "5000", txid: "payout-0", status: "confirmed" },
    ],
    platform_fee: "5000",
    network_fee: "1000",
    received_amount: "94000",
    tx: { in: "tx-on-time", out: "payout-0", platform_out: "payout-0", raw: "payout-0-signed" },
    ...fields,
  });
}

// ---------- The fake chain ----------

type Deposit = { payments: ChainPayment[]; spent: Set<string> };

type FakeChainOptions = {
  /** What estimateNetworkCost answers. */
  estimate?: bigint | undefined;
  /** Taken from the balance before a sweep, like TON's storage fee. */
  storageFee?: bigint;
  /** The chain refuses a destination share below this, like BTC's dust limit. */
  dustLimit?: bigint;
};

/**
 * A chain where a payout sweeps every confirmed, unspent payment at the
 * deposit: it splits by F1, saves its checkpoint, "broadcasts", and proves
 * the saved plan on the next call.
 */
function fakeChain(options: FakeChainOptions = {}) {
  const deposits = new Map<string, Deposit>();
  const failingLookups = new Set<string>();
  const payoutCalls: PayoutRequest[] = [];
  const broadcasts: { depositAddress: string; txid: string; swept: bigint }[] = [];
  const lookups: string[] = [];
  let sweepCounter = 0;
  let override: ((request: PayoutRequest) => Promise<PayoutResult>) | undefined;

  function deposit(address: string): Deposit {
    let found = deposits.get(address);
    if (!found) {
      found = { payments: [], spent: new Set() };
      deposits.set(address, found);
    }
    return found;
  }

  async function sweep(request: PayoutRequest): Promise<PayoutResult> {
    if (request.checkpoint) {
      return { status: "paid", transfers: request.checkpoint.plan.transfers };
    }
    const held = deposit(request.depositAddress);
    const unspent = held.payments.filter((p) => p.confirmations >= 1 && !held.spent.has(p.txid));
    const total = unspent.reduce((sum, p) => sum + p.amount, 0n) - (options.storageFee ?? 0n);
    if (total <= 0n || total < request.minimumAmount) {
      return { status: "pending", reason: "the deposit holds less than the minimum" };
    }
    const split = splitPayout({ received: total, networkCost: NETWORK_COST, feeRate: request.feeRate, feeExempt: request.feeExempt ?? 0n });
    if (split === undefined || split.merchantAmount < (options.dustLimit ?? 0n)) {
      return { status: "too_small", reason: "fake chain: too small" };
    }
    sweepCounter += 1;
    const txid = `sweep-${request.depositAddress}-${sweepCounter}`;
    const plan = {
      transfers: [
        { kind: request.destinationKind, to: request.destination, amount: split.merchantAmount, txid },
        ...(split.platformFee > 0n
          ? [{ kind: "platform_fee" as const, to: PLATFORM, amount: split.platformFee, txid }]
          : []),
      ],
      platformFee: split.platformFee,
      networkCost: NETWORK_COST,
    };
    if (!(await request.saveCheckpoint({ state: `signed-${txid}`, plan }))) {
      return { status: "pending", reason: "another run saved first" };
    }
    for (const p of unspent) held.spent.add(p.txid);
    broadcasts.push({ depositAddress: request.depositAddress, txid, swept: total });
    return { status: "pending", reason: "broadcast" };
  }

  const adapter: ChainAdapter = {
    asset: "btc",
    requiredConfirmations: 1,
    isValidAddress: (address) => address.startsWith("merchant-"),
    canPayOutAs: (receive) => receive === "btc",
    newDeposit: async () => {
      throw new Error("not used by the watcher");
    },
    getPayments: async (address) => {
      lookups.push(address);
      if (failingLookups.has(address)) return undefined;
      return [...deposit(address).payments];
    },
    estimateNetworkCost: async () => ("estimate" in options ? options.estimate : NETWORK_COST),
    payout: async (request) => {
      payoutCalls.push(request);
      return await (override ?? sweep)(request);
    },
  };

  return {
    /** The payer sends `amount` to `address`. */
    pay(address: string, txid: string, amount: bigint, fields: Partial<ChainPayment> = {}) {
      deposit(address).payments.push({ txid, amount, confirmations: 1, ...fields });
    },
    /** A payout made before this test (the merchant payout) already spent it. */
    spent(address: string, ...txids: string[]) {
      for (const txid of txids) deposit(address).spent.add(txid);
    },
    confirm(address: string, txid: string) {
      const payment = deposit(address).payments.find((p) => p.txid === txid);
      if (payment) payment.confirmations = 1;
    },
    failLookups(address: string) {
      failingLookups.add(address);
    },
    payoutWith(next: ((request: PayoutRequest) => Promise<PayoutResult>) | undefined) {
      override = next;
    },
    sweep,
    payoutCalls,
    broadcasts,
    lookups,
    ports(now: number): WatcherPorts {
      return { now: () => now, chains: { btc: adapter }, swap: unusedSwap() };
    },
    callsFor: (address: string) => payoutCalls.filter((r) => r.depositAddress === address),
    broadcastsFor: (address: string) => broadcasts.filter((b) => b.depositAddress === address),
  };
}

async function invoiceNow(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

type StoredTransfer = { kind: string; to: string; amount: string; txid: string; status: string; payout?: number };
type StoredPayment = { txid: string; amount: string; on_time: boolean; payout?: number };

type Stored = { transfers?: StoredTransfer[]; payments?: StoredPayment[] } | null;

const routeTransfers = (invoice: Stored | Record<string, unknown>, n: number) =>
  ((invoice as Stored)?.transfers ?? []).filter((t) => t.payout === n).map((t) => [t.kind, t.to, t.amount, t.status]);

const paymentPayouts = (invoice: Stored | Record<string, unknown>) =>
  Object.fromEntries(((invoice as Stored)?.payments ?? []).map((p) => [p.txid, p.payout ?? null]));

/** Passes 6 minutes apart: closed invoices are looked at every 5 minutes. */
async function passes(chain: ReturnType<typeof fakeChain>, from: number, count: number) {
  for (let i = 0; i < count; i += 1) {
    await runWatcherPass(chain.ports(from + i * 6 * MINUTE));
  }
}

// ---------- Where money on a closed invoice goes ----------

describe("routing money that reaches a closed invoice", () => {
  // Each row: an invoice that closed, then money on its deposit. 5% fee and a
  // network cost of 1,000 sat; the refund address gets the rest.
  const cases: {
    name: string;
    status: Closed;
    setUp: (userId: string) => Promise<{ invoiceId: string; address: string; closedAt: number }>;
    paid: { txid: string; amount: bigint; seenAfterClose: number }[];
    lookAfterClose: number;
    expect:
      | { routed: { amount: bigint; platformFee: bigint; txids: string[] }; outcome: string; onTime: Record<string, boolean> }
      | { routed: null; recorded: string[] };
  }[] = [
    {
      name: "partial money at expiry goes to the refund address, and the invoice stays expired, partially paid",
      status: "expired",
      setUp: (userId) =>
        closedInvoice("expired", userId, {
          outcome: "partially_paid",
          paid_amount: "40000",
          payments: [{ txid: "tx-partial", amount: "40000", first_seen_at: NOW, confirmations: 1, on_time: true }],
        }),
      paid: [{ txid: "tx-partial", amount: 40_000n, seenAfterClose: -(EXPIRES_AT - NOW) }],
      lookAfterClose: MINUTE,
      // fee ceil(40,000 × 5%) = 2,000; 40,000 − 2,000 − 1,000 = 37,000
      expect: { routed: { amount: 37_000n, platformFee: 2_000n, txids: ["tx-partial"] }, outcome: "partially_paid", onTime: { "tx-partial": true } },
    },
    {
      name: "money after a cancel, inside the 7 days, is routed as a late payment",
      status: "cancelled",
      setUp: (userId) => closedInvoice("cancelled", userId),
      paid: [{ txid: "tx-after-cancel", amount: 50_000n, seenAfterClose: DAY }],
      lookAfterClose: DAY + MINUTE,
      // 50,000 − 2,500 − 1,000 = 46,500
      expect: { routed: { amount: 46_500n, platformFee: 2_500n, txids: ["tx-after-cancel"] }, outcome: "", onTime: { "tx-after-cancel": false } },
    },
    {
      name: "money after a cancel, after the 7 days, is not recorded or routed",
      status: "cancelled",
      setUp: (userId) => closedInvoice("cancelled", userId),
      paid: [{ txid: "tx-too-late", amount: 50_000n, seenAfterClose: WEEK + MINUTE }],
      lookAfterClose: WEEK + 2 * MINUTE,
      expect: { routed: null, recorded: [] },
    },
    {
      name: "money after completion, inside the 7 days, is routed; the merchant payout's money is not",
      status: "completed",
      setUp: (userId) => completedInvoice(userId),
      paid: [{ txid: "tx-after-completion", amount: 30_000n, seenAfterClose: 3 * DAY }],
      lookAfterClose: 3 * DAY + MINUTE,
      // 30,000 − 1,500 − 1,000 = 27,500
      expect: { routed: { amount: 27_500n, platformFee: 1_500n, txids: ["tx-after-completion"] }, outcome: "", onTime: { "tx-on-time": true, "tx-after-completion": false } },
    },
    {
      name: "money after completion, after the 7 days, is not recorded or routed",
      status: "completed",
      setUp: (userId) => completedInvoice(userId),
      paid: [{ txid: "tx-after-week", amount: 30_000n, seenAfterClose: WEEK + MINUTE }],
      lookAfterClose: WEEK + 2 * MINUTE,
      expect: { routed: null, recorded: ["tx-on-time"] },
    },
    {
      name: "late money after an expiry with nothing paid in time is routed",
      status: "expired",
      setUp: (userId) => closedInvoice("expired", userId),
      paid: [{ txid: "tx-late", amount: 20_000n, seenAfterClose: 10 * MINUTE }],
      lookAfterClose: 11 * MINUTE,
      // 20,000 − 1,000 − 1,000 = 18,000
      expect: { routed: { amount: 18_000n, platformFee: 1_000n, txids: ["tx-late"] }, outcome: "", onTime: { "tx-late": false } },
    },
  ];

  for (const row of cases) {
    it(row.name, async () => {
      const userId = await merchant();
      const { invoiceId, address, closedAt } = await row.setUp(userId);
      const chain = fakeChain();
      if (row.status === "completed") {
        chain.pay(address, "tx-on-time", 100_000n, { seenAt: NOW - MINUTE });
        chain.spent(address, "tx-on-time");
      }
      for (const p of row.paid) chain.pay(address, p.txid, p.amount, { seenAt: closedAt + p.seenAfterClose });

      await passes(chain, closedAt + row.lookAfterClose, 2);

      const invoice = await invoiceNow(invoiceId);
      assert.equal(invoice?.status, row.status, "the status changed");
      if (row.expect.routed === null) {
        assert.equal(chain.callsFor(address).length, 0, "a payout was asked for");
        assert.deepEqual((invoice?.payments ?? []).map((p: StoredPayment) => p.txid), row.expect.recorded);
        return;
      }
      const { amount, platformFee, txids } = row.expect.routed;
      assert.equal(chain.broadcastsFor(address).length, 1);
      const [request] = chain.callsFor(address);
      assert.equal(request?.destination, REFUND);
      assert.equal(request?.destinationKind, "refund_route");
      assert.equal(request?.receiveAsset, "btc");
      assert.equal(request?.feeRate, FEE_RATE);
      const txid = chain.broadcastsFor(address)[0]!.txid;
      assert.deepEqual(routeTransfers(invoice, 1), [
        ["refund_route", REFUND, amount.toString(), "confirmed"],
        ["platform_fee", PLATFORM, platformFee.toString(), "confirmed"],
      ]);
      assert.ok((invoice?.transfers ?? []).filter((t: StoredTransfer) => t.payout === 1).every((t: StoredTransfer) => t.txid === txid));
      assert.equal(invoice?.refund_routes?.[0]?.n, 1);
      assert.equal(invoice?.refund_routes?.[0]?.state, "paid");
      assert.equal(invoice?.refund_routes?.[0]?.destination, REFUND);
      assert.equal(invoice?.refund_routes?.[0]?.source, "refund_address");
      for (const routed of txids) assert.equal(paymentPayouts(invoice)[routed], 1, `${routed} is not marked routed`);
      assert.deepEqual(
        Object.fromEntries((invoice?.payments ?? []).map((p: StoredPayment) => [p.txid, p.on_time])),
        row.expect.onTime,
      );
      assert.equal(invoice?.outcome ?? "", row.expect.outcome);
    });
  }
});

describe("where a refund route goes", () => {
  const cases: {
    name: string;
    addresses: { refund?: string; payout?: string };
    expect: { to: string; source: string } | "held";
  }[] = [
    { name: "the refund address first", addresses: { refund: REFUND, payout: PAYOUT }, expect: { to: REFUND, source: "refund_address" } },
    { name: "the payout address when there is no refund address", addresses: { payout: PAYOUT }, expect: { to: PAYOUT, source: "payout_address" } },
    { name: "the payout address when the refund address is not valid for the chain", addresses: { refund: "not-an-address", payout: PAYOUT }, expect: { to: PAYOUT, source: "payout_address" } },
    { name: "held for manual handling when there is neither", addresses: {}, expect: "held" },
  ];

  for (const row of cases) {
    it(row.name, async () => {
      const userId = await merchant(row.addresses);
      const { invoiceId, address } = await closedInvoice("cancelled", userId);
      const chain = fakeChain();
      chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });

      await passes(chain, NOW + 2 * MINUTE, 2);

      const invoice = await invoiceNow(invoiceId);
      if (row.expect === "held") {
        assert.equal(chain.callsFor(address).length, 0, "paid out with nowhere to send it");
        assert.equal(invoice?.outcome, "held_for_manual_handling");
        assert.match(invoice?.review_reason ?? "", new RegExp(`50000.*${address}`));
        assert.equal(paymentPayouts(invoice)["tx-late"], null);
        return;
      }
      assert.equal(chain.callsFor(address)[0]?.destination, row.expect.to);
      assert.equal(invoice?.refund_routes?.[0]?.source, row.expect.source);
      assert.equal(paymentPayouts(invoice)["tx-late"], 1);
    });
  }

  it("forwards held money once the merchant sets an address inside the 7 days", async () => {
    const userId = await merchant({});
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });
    await passes(chain, NOW + 2 * MINUTE, 1);
    assert.equal((await invoiceNow(invoiceId))?.outcome, "held_for_manual_handling");

    await db.collection("users").updateOne({ user_id: userId }, { $set: { "refund_addresses.btc": REFUND } });
    await passes(chain, NOW + DAY, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.outcome, "");
    assert.equal(chain.callsFor(address)[0]?.destination, REFUND);
    assert.equal(paymentPayouts(invoice)["tx-late"], 1);
  });
});

// ---------- Too small to forward ----------

describe("money too small to forward", () => {
  it("stays at the deposit, marked, without asking the chain, when F1 leaves nothing; a top-up forwards it all", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    // 1,000 sat: fee 50 + network 1,000 leave the refund address nothing.
    chain.pay(address, "tx-dust", 1_000n, { seenAt: NOW + MINUTE });

    await passes(chain, NOW + 2 * MINUTE, 2);

    let invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.outcome, "too_small_to_forward");
    assert.equal(chain.callsFor(address).length, 0);
    assert.equal(paymentPayouts(invoice)["tx-dust"], null);

    chain.pay(address, "tx-top-up", 40_000n, { seenAt: NOW + DAY });
    await passes(chain, NOW + DAY + MINUTE, 2);

    invoice = await invoiceNow(invoiceId);
    // 41,000: fee 2,050, network 1,000, refund address 37,950
    assert.deepEqual(routeTransfers(invoice, 1), [
      ["refund_route", REFUND, "37950", "confirmed"],
      ["platform_fee", PLATFORM, "2050", "confirmed"],
    ]);
    assert.deepEqual(paymentPayouts(invoice), { "tx-dust": 1, "tx-top-up": 1 });
    assert.equal(invoice?.outcome, "");
  });

  it("is marked when the chain's own dust limit refuses it, though F1 would forward it", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain({ dustLimit: 546n });
    // 1,500: fee 75, network 1,000, share 425 < 546
    chain.pay(address, "tx-small", 1_500n, { seenAt: NOW + MINUTE });

    await passes(chain, NOW + 2 * MINUTE, 1);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.outcome, "too_small_to_forward");
    assert.equal(chain.broadcastsFor(address).length, 0);
    assert.equal(paymentPayouts(invoice)["tx-small"], null);
  });

  it("asks the chain when the network cost estimate is unavailable", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain({ estimate: undefined });
    chain.pay(address, "tx-dust", 1_000n, { seenAt: NOW + MINUTE });

    await passes(chain, NOW + 2 * MINUTE, 1);

    assert.equal(chain.callsFor(address).length, 1);
    assert.equal((await invoiceNow(invoiceId))?.outcome, "too_small_to_forward");
  });

  it("is held for manual handling when the watch ends, with the amount and the deposit address (owner decision 2026-11-19)", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-dust", 1_000n, { seenAt: NOW + MINUTE });
    await passes(chain, NOW + 2 * MINUTE, 1);

    await passes(chain, NOW + WEEK + 2 * DAY, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.outcome, "held_for_manual_handling");
    assert.equal(invoice?.watch_done, true);
    assert.match(invoice?.review_reason ?? "", new RegExp(`Held for manual handling: .*1000 .*tx-dust too small to forward.*${address}`));
    assert.equal(chain.broadcastsFor(address).length, 0);
  });

  /** A confirmed invoice paid in full with 1,000 sat: fee 50 + network 1,000 leave the merchant nothing. */
  async function dustInvoice(userId: string) {
    const invoiceId = randomUUID();
    invoiceIds.push(invoiceId);
    const address = `deposit-${invoiceId}`;
    await db.collection("invoices").insertOne({
      invoice_id: invoiceId,
      user_id: userId,
      status: "confirmed",
      crypto: "btc",
      to_crypto: "btc",
      to_address: PAYOUT,
      amount: "1000",
      amount_fiat: "1",
      paid_amount: "1000",
      address,
      lifetime: 30,
      fee_rate: "0.05",
      timestamps: { created: CREATED, waiting: CREATED, confirmed: NOW - MINUTE },
      private: { private_key: sealedKey() },
      payments: [{ txid: "tx-tiny", amount: "1000", first_seen_at: CREATED + MINUTE, confirmations: 1, on_time: true }],
      status_log: [{ from: "", to: "waiting", at: CREATED }, { from: "waiting", to: "confirmed", at: NOW - MINUTE }],
    });
    return { invoiceId, address };
  }

  it("closes a confirmed invoice whose merchant payout is too small: failed, marked, watched for 7 days, and logged", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await dustInvoice(userId);
    const chain = fakeChain();
    chain.pay(address, "tx-tiny", 1_000n);

    await passes(chain, NOW, 1);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.equal(invoice?.outcome, "too_small_to_forward");
    assert.equal(invoice?.timestamps?.failed, NOW);
    assert.equal(invoice?.watch_until, NOW + WEEK);
    assert.deepEqual(invoice?.status_log?.at(-1), { from: "confirmed", to: "failed", at: NOW });
    assert.match(invoice?.review_reason ?? "", new RegExp(`Too small to forward.*1000.*${address}`));
    assert.equal(chain.broadcastsFor(address).length, 0);
  });

  it("is no longer retried as a merchant payout once closed", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await dustInvoice(userId);
    const chain = fakeChain();
    chain.pay(address, "tx-tiny", 1_000n);

    await passes(chain, NOW, 4);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.equal(invoice?.status_log?.length, 3, "one close, logged once");
    assert.equal(chain.callsFor(address).filter((r) => r.destinationKind === "merchant_payout").length, 1);
    assert.equal(chain.broadcastsFor(address).length, 0);
  });

  it("forwards a closed dust invoice's money together with a top-up that arrives within the 7 days", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await dustInvoice(userId);
    const chain = fakeChain();
    chain.pay(address, "tx-tiny", 1_000n);
    await passes(chain, NOW, 1);

    chain.pay(address, "tx-top-up", 40_000n, { seenAt: NOW + DAY });
    await passes(chain, NOW + DAY + MINUTE, 2);

    const invoice = await invoiceNow(invoiceId);
    // 41,000: fee 2,050, network 1,000, refund address 37,950
    assert.deepEqual(routeTransfers(invoice, 1), [
      ["refund_route", REFUND, "37950", "confirmed"],
      ["platform_fee", PLATFORM, "2050", "confirmed"],
    ]);
    assert.deepEqual(paymentPayouts(invoice), { "tx-tiny": 1, "tx-top-up": 1 });
    assert.equal(invoice?.outcome, "");
    assert.equal(invoice?.status, "failed");
  });

  it("holds a closed dust invoice's money for manual handling when the watch ends, naming the amount and the deposit address", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await dustInvoice(userId);
    const chain = fakeChain();
    chain.pay(address, "tx-tiny", 1_000n);
    await passes(chain, NOW, 1);

    await passes(chain, NOW + WEEK + 2 * DAY, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.watch_done, true);
    assert.equal(invoice?.status, "failed", "the status does not change");
    assert.equal(invoice?.outcome, "held_for_manual_handling");
    assert.match(invoice?.review_reason ?? "", new RegExp(`Held for manual handling: .*1000 .*tx-tiny too small to forward.*${address}`));
    assert.equal(chain.broadcastsFor(address).length, 0);
  });
});

// ---------- Accounting: what was paid out, from which payments, to whom ----------

describe("accounting for money a payout swept", () => {
  it("records late money that the merchant payout swept as paid out by it, and never routes it again", async () => {
    const userId = await merchant();
    // The payout swept 130,000: the on-time 100,000 and a late 30,000.
    const { invoiceId, address } = await completedInvoice(userId, {
      transfers: [
        { kind: "merchant_payout", to: PAYOUT, amount: "122500", txid: "payout-0", status: "confirmed" },
        { kind: "platform_fee", to: PLATFORM, amount: "6500", txid: "payout-0", status: "confirmed" },
      ],
      platform_fee: "6500",
      received_amount: "122500",
    });
    const chain = fakeChain();
    chain.pay(address, "tx-on-time", 100_000n, { seenAt: NOW - MINUTE });
    chain.pay(address, "tx-before-payout", 30_000n, { seenAt: NOW - 30_000 });
    chain.spent(address, "tx-on-time", "tx-before-payout");

    await passes(chain, NOW + MINUTE, 3);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(chain.callsFor(address).length, 0, "routed money the merchant payout already sent");
    assert.deepEqual(paymentPayouts(invoice), { "tx-on-time": 0, "tx-before-payout": 0 });
    assert.equal(
      (invoice?.payments ?? []).find((p: StoredPayment) => p.txid === "tx-before-payout")?.on_time,
      false,
    );
  });

  it("counts a payment as swept though the chain's storage fee took a few units of it", async () => {
    const userId = await merchant();
    // TON-like: the payout swept 129,997 of the 130,000 credited.
    const { invoiceId, address } = await completedInvoice(userId, {
      transfers: [
        { kind: "merchant_payout", to: PAYOUT, amount: "122497", txid: "payout-0", status: "confirmed" },
        { kind: "platform_fee", to: PLATFORM, amount: "6500", txid: "payout-0", status: "confirmed" },
      ],
      platform_fee: "6500",
      received_amount: "122497",
    });
    const chain = fakeChain();
    chain.pay(address, "tx-on-time", 100_000n, { seenAt: NOW - MINUTE });
    chain.pay(address, "tx-before-payout", 30_000n, { seenAt: NOW - 30_000 });
    chain.spent(address, "tx-on-time", "tx-before-payout");

    await passes(chain, NOW + MINUTE, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(chain.callsFor(address).length, 0);
    assert.deepEqual(paymentPayouts(invoice), { "tx-on-time": 0, "tx-before-payout": 0 });
  });

  it("routes a second late payment in its own route, with its own checkpoint", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await completedInvoice(userId);
    const chain = fakeChain();
    chain.pay(address, "tx-on-time", 100_000n, { seenAt: NOW - MINUTE });
    chain.spent(address, "tx-on-time");
    chain.pay(address, "tx-late-1", 30_000n, { seenAt: NOW + DAY });
    await passes(chain, NOW + DAY + MINUTE, 2);

    chain.pay(address, "tx-late-2", 20_000n, { seenAt: NOW + 2 * DAY });
    await passes(chain, NOW + 2 * DAY + MINUTE, 2);

    const invoice = await invoiceNow(invoiceId);
    const calls = chain.callsFor(address);
    assert.equal(calls.length, 4);
    // Every route starts without a checkpoint: never the merchant payout's, never the last route's.
    assert.equal(calls[0]?.checkpoint, undefined);
    assert.equal(calls[1]?.checkpoint?.state, `signed-${chain.broadcastsFor(address)[0]!.txid}`);
    assert.equal(calls[2]?.checkpoint, undefined);
    assert.equal(calls[3]?.checkpoint?.state, `signed-${chain.broadcastsFor(address)[1]!.txid}`);
    assert.equal(chain.broadcastsFor(address).length, 2);
    assert.deepEqual(paymentPayouts(invoice), { "tx-on-time": 0, "tx-late-1": 1, "tx-late-2": 2 });
    // 20,000 − 1,000 − 1,000
    assert.deepEqual(routeTransfers(invoice, 2), [
      ["refund_route", REFUND, "18000", "confirmed"],
      ["platform_fee", PLATFORM, "1000", "confirmed"],
    ]);
    assert.deepEqual(invoice?.refund_routes?.map((r: { n: number; state: string }) => [r.n, r.state]), [[1, "paid"], [2, "paid"]]);
    // The merchant payout's record is untouched.
    assert.equal(invoice?.received_amount, "94000");
    assert.equal(invoice?.tx?.out, "payout-0");
  });

  it("waits for a late payment's confirmations before routing it", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE, confirmations: 0 });

    await passes(chain, NOW + 2 * MINUTE, 1);
    assert.equal(chain.callsFor(address).length, 0);
    assert.equal((await invoiceNow(invoiceId))?.payments?.[0]?.confirmations, 0);

    chain.confirm(address, "tx-late");
    await passes(chain, NOW + 20 * MINUTE, 2);

    assert.equal(paymentPayouts(await invoiceNow(invoiceId))["tx-late"], 1);
  });

  it("asks the chain to forward any amount, so a storage fee can never hold a refund route back", async () => {
    const userId = await merchant();
    const { address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain({ storageFee: 3n });
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });

    await passes(chain, NOW + 2 * MINUTE, 1);

    assert.equal(chain.callsFor(address)[0]?.minimumAmount, 1n);
    assert.equal(chain.broadcastsFor(address)[0]?.swept, 49_997n);
  });
});

// ---------- The deposit key ----------

describe("the key a refund route spends with", () => {
  it("is the deposit's own sealed key, intact, so the chain can open it", async () => {
    const userId = await merchant();
    const sealed = sealSecret("bitcoin-deposit-key", "the deposit's private key");
    const { address } = await closedInvoice("cancelled", userId, { private: { private_key: sealed } });
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });

    await passes(chain, NOW + 2 * MINUTE, 1);

    const key = chain.callsFor(address)[0]?.depositKey;
    assert.equal(key?.kind, "sealed_key");
    if (key?.kind !== "sealed_key") return;
    assert.equal(openSecret("bitcoin-deposit-key", key.sealed), "the deposit's private key");
  });
});

// ---------- Crashes, races and failures ----------

describe("a refund route that is interrupted or fails", () => {
  it("is never paid twice after a crash that follows a saved checkpoint", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });
    // Pass 1 saves the checkpoint, broadcasts, then the process dies.
    chain.payoutWith(async (request) => {
      await chain.sweep(request);
      throw new Error("process killed");
    });
    await passes(chain, NOW + 2 * MINUTE, 1);
    assert.equal((await invoiceNow(invoiceId))?.refund_routes?.[0]?.state, "processing");

    chain.payoutWith(undefined);
    await passes(chain, NOW + 3 * MINUTE, 2);

    const calls = chain.callsFor(address);
    assert.equal(calls.length, 2, "asked again after the proof");
    assert.equal(calls[1]?.checkpoint?.state, `signed-${chain.broadcastsFor(address)[0]!.txid}`);
    assert.equal(calls[1]?.destination, REFUND);
    assert.equal(chain.broadcastsFor(address).length, 1, "paid twice");
    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.refund_routes?.length, 1);
    assert.equal(invoice?.refund_routes?.[0]?.state, "paid");
    assert.equal(routeTransfers(invoice, 1).length, 2);
  });

  it("lets only one of two overlapping runs save a route's checkpoint", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });
    let release!: () => void;
    const bothPrepared = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    const saves: boolean[] = [];
    chain.payoutWith(async (request) => {
      if (request.depositAddress !== address) return { status: "pending", reason: "not this test's" };
      if (++waiting === 2) release();
      await bothPrepared;
      saves.push(await request.saveCheckpoint({ state: `signed-by-run-${waiting}`, plan: { transfers: [], platformFee: 0n, networkCost: 0n } }));
      return { status: "pending", reason: "race" };
    });

    await Promise.all([
      runWatcherPass(chain.ports(NOW + 2 * MINUTE)),
      runWatcherPass(chain.ports(NOW + 2 * MINUTE)),
    ]);

    assert.deepEqual(saves.sort(), [false, true]);
    assert.equal((await invoiceNow(invoiceId))?.refund_routes?.length, 1);
  });

  it("keeps a failed route's where-the-money-is message, marks it held, and stops", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });
    await passes(chain, NOW + 2 * MINUTE, 1);
    const message = `Payout stopped: the refund address can't receive. All funds are still at deposit address ${address}.`;
    chain.payoutWith(async () => ({ status: "failed", message, transfers: [] }));

    await passes(chain, NOW + 3 * MINUTE, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "cancelled");
    assert.equal(invoice?.outcome, "held_for_manual_handling");
    assert.equal(invoice?.review_reason, message);
    assert.equal(invoice?.refund_routes?.[0]?.state, "failed");
    assert.deepEqual(routeTransfers(invoice, 1).map((t) => t[3]), ["failed", "failed"]);
    assert.equal(paymentPayouts(invoice)["tx-late"], null);
    assert.equal(invoice?.watch_done, true);
    assert.equal(chain.callsFor(address).length, 2, "kept calling after the failure");
  });

  it("records a route that fails before anything is saved, with its message", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });
    const message = `Payout stopped: nothing was sent. All funds are still at deposit address ${address}.`;
    chain.payoutWith(async () => ({ status: "failed", message, transfers: [] }));

    await passes(chain, NOW + 2 * MINUTE, 1);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.outcome, "held_for_manual_handling");
    assert.equal(invoice?.review_reason, message);
    assert.equal(invoice?.refund_routes?.[0]?.state, "failed");
    assert.equal(invoice?.refund_routes?.[0]?.destination, REFUND);
  });

  it("is still followed after the 7 days while its checkpoint is saved", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + WEEK - 10 * MINUTE });
    chain.payoutWith(async (request) => {
      if (!request.checkpoint) return await chain.sweep(request);
      return { status: "pending", reason: "not landed yet" };
    });
    await passes(chain, NOW + WEEK - 5 * MINUTE, 1);

    chain.payoutWith(undefined);
    await passes(chain, NOW + WEEK + DAY, 1);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.refund_routes?.[0]?.state, "paid");
    assert.equal(paymentPayouts(invoice)["tx-late"], 1);
  });

  it("notes a refund route still pending a day after it was saved", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });
    chain.payoutWith(async (request) => {
      if (!request.checkpoint) return await chain.sweep(request);
      return { status: "pending", reason: "not landed yet" };
    });
    await passes(chain, NOW + 2 * MINUTE, 1);

    await passes(chain, NOW + 2 * DAY, 1);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.refund_routes?.[0]?.state, "processing");
    assert.match(invoice?.review_reason ?? "", new RegExp(`24 hours.*not landed yet.*${address}`));
  });
});

// ---------- The 7-day watch ----------

describe("the 7-day watch", () => {
  it("starts when an unpaid invoice expires", async () => {
    const invoiceId = randomUUID();
    invoiceIds.push(invoiceId);
    await db.collection("invoices").insertOne({
      invoice_id: invoiceId,
      user_id: randomUUID(),
      status: "waiting",
      crypto: "btc",
      to_crypto: "btc",
      to_address: PAYOUT,
      amount: "100000",
      amount_fiat: "2500",
      paid_amount: "0",
      address: `deposit-${invoiceId}`,
      lifetime: 30,
      timestamps: { created: CREATED, waiting: CREATED },
      private: { private_key: sealedKey() },
    });
    const at = EXPIRES_AT + MINUTE;

    await runWatcherPass(fakeChain().ports(at));

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.equal(invoice?.watch_until, at + WEEK);
  });

  it("starts when a merchant's-list invoice expires with no coin picked", async () => {
    const invoiceId = randomUUID();
    invoiceIds.push(invoiceId);
    await db.collection("invoices").insertOne({
      invoice_id: invoiceId,
      user_id: randomUUID(),
      status: "waiting",
      mode: "merchant_list",
      crypto: "",
      amount: "0",
      amount_fiat: "2500",
      paid_amount: "0",
      address: "",
      lifetime: 30,
      timestamps: { created: CREATED, waiting: CREATED },
    });
    const at = EXPIRES_AT + MINUTE;

    await runWatcherPass(fakeChain().ports(at));

    assert.equal((await invoiceNow(invoiceId))?.watch_until, at + WEEK);
  });

  it("starts when the merchant payout completes", async () => {
    const userId = await merchant();
    const invoiceId = randomUUID();
    invoiceIds.push(invoiceId);
    const address = `deposit-${invoiceId}`;
    await db.collection("invoices").insertOne({
      invoice_id: invoiceId,
      user_id: userId,
      status: "confirmed",
      crypto: "btc",
      to_crypto: "btc",
      to_address: PAYOUT,
      amount: "100000",
      amount_fiat: "2500",
      paid_amount: "100000",
      address,
      lifetime: 30,
      fee_rate: "0.05",
      timestamps: { created: CREATED, waiting: CREATED, confirmed: NOW - MINUTE },
      private: { private_key: sealedKey() },
      payments: [A_PAID],
    });
    const chain = fakeChain();
    chain.pay(address, "tx-on-time", 100_000n, { seenAt: NOW - MINUTE });

    await runWatcherPass(chain.ports(NOW));
    await runWatcherPass(chain.ports(NOW + MINUTE));

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.watch_until, NOW + MINUTE + WEEK);
    // The merchant payout is not a refund route.
    assert.equal(chain.callsFor(address)[0]?.destinationKind, "merchant_payout");
    assert.equal(invoice?.refund_routes?.length ?? 0, 0);
  });

  it("looks at a closed invoice at most every 5 minutes", async () => {
    const userId = await merchant();
    const { address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();

    await runWatcherPass(chain.ports(NOW + MINUTE));
    await runWatcherPass(chain.ports(NOW + 2 * MINUTE));
    await runWatcherPass(chain.ports(NOW + 7 * MINUTE));

    assert.equal(chain.lookups.filter((a) => a === address).length, 2);
  });

  it("changes nothing when the chain lookup fails", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: NOW + MINUTE });
    chain.failLookups(address);

    await passes(chain, NOW + 2 * MINUTE, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.deepEqual(invoice?.payments, []);
    assert.equal(chain.callsFor(address).length, 0);
  });

  it("does not watch an invoice closed before the watch existed", async () => {
    const userId = await merchant();
    const { address } = await closedInvoice("expired", userId, { watch_until: null });
    const chain = fakeChain();
    chain.pay(address, "tx-late", 50_000n, { seenAt: EXPIRES_AT + MINUTE });

    await passes(chain, EXPIRES_AT + 2 * MINUTE, 1);

    assert.ok(!chain.lookups.includes(address));
  });

  it("routes a payment seen just before the watch ended, on the first look after", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    await passes(chain, NOW + WEEK - 3 * MINUTE, 1);
    chain.pay(address, "tx-last-minute", 50_000n, { seenAt: NOW + WEEK - MINUTE });

    await passes(chain, NOW + WEEK + 3 * MINUTE, 2);

    assert.equal(paymentPayouts(await invoiceNow(invoiceId))["tx-last-minute"], 1);
  });

  it("holds money still unrouted a day after the watch ended, and stops", async () => {
    const userId = await merchant();
    const { invoiceId, address } = await closedInvoice("cancelled", userId);
    const chain = fakeChain();
    chain.pay(address, "tx-stuck", 50_000n, { seenAt: NOW + WEEK - MINUTE, confirmations: 0 });
    await passes(chain, NOW + WEEK - 30_000, 1);

    await passes(chain, NOW + WEEK + 2 * DAY, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.outcome, "held_for_manual_handling");
    assert.match(invoice?.review_reason ?? "", new RegExp(`tx-stuck.*${address}`));
    assert.equal(invoice?.watch_done, true);
    const lookups = chain.lookups.filter((a) => a === address).length;
    await passes(chain, NOW + WEEK + 3 * DAY, 1);
    assert.equal(chain.lookups.filter((a) => a === address).length, lookups, "still watched");
  });

  it("ends quietly for an invoice that got no late money", async () => {
    const userId = await merchant();
    const { invoiceId } = await completedInvoice(userId);
    const chain = fakeChain();

    await passes(chain, NOW + WEEK + DAY + MINUTE, 1);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.watch_done, true);
    assert.equal(invoice?.outcome ?? "", "");
  });
});
