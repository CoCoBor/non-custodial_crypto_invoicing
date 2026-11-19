import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import type {
  AfterPayoutRequest,
  AfterPayoutResult,
  ChainAdapter,
  ChainPayment,
  PayoutRequest,
  PayoutResult,
  Transfer,
} from "../../src/chains/adapter.js";
import { connectToMongoDb, disconnectFromMongoDB } from "../../src/infrastructure/database/mongodb.js";
import { runWatcherPass, type WatcherPorts } from "../../src/invoice/invoice.watcher.js";
import { unusedSwap } from "../helpers/fake-swap.js";

// Work an adapter does after a proven payout, which must not hold it up
// (owner decision 2026-11-20: a Tron invoice is completed once the USDT is
// final; the leftover TRX goes back to the gas wallet afterwards). Watcher
// passes with the chain faked at the registry seam.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test

const NOW = Date.parse("2026-11-20T12:00:00Z");
const MINUTE = 60_000;
const AMOUNT = 100_000_000n;
const MERCHANT = "merchant-payout";
const REFUND = "merchant-refund";
const GAS_WALLET = "gas-wallet";

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
  return { keyVersion: 1, initialisationVector: randomBytes(12), authenticationTag: randomBytes(16), ciphertext: randomBytes(32) };
}

async function merchant() {
  const userId = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    merchant_fee: "0.05",
    refund_addresses: { usdttrx: REFUND },
    payout_addresses: { usdttrx: MERCHANT },
  });
  return userId;
}

/** A confirmed USDT-on-Tron invoice, paid in one transaction. */
async function confirmedInvoice(fields: Record<string, unknown> = {}) {
  const invoiceId = randomUUID();
  invoiceIds.push(invoiceId);
  const address = `deposit-${invoiceId}`;
  await db.collection("invoices").insertOne({
    invoice_id: invoiceId,
    user_id: await merchant(),
    status: "confirmed",
    crypto: "usdttrx",
    to_crypto: "usdttrx",
    to_address: MERCHANT,
    amount: AMOUNT.toString(),
    amount_fiat: "10000",
    paid_amount: AMOUNT.toString(),
    address,
    lifetime: 30,
    fee_rate: "0.05",
    payments: [{ txid: "tx-paid", amount: AMOUNT.toString(), first_seen_at: NOW - 5 * MINUTE, confirmations: 1, on_time: true }],
    timestamps: { created: NOW - 10 * MINUTE, waiting: NOW - 10 * MINUTE, confirmed: NOW - MINUTE },
    status_log: [],
    private: { private_key: sealedKey() },
    ...fields,
  });
  return { invoiceId, address };
}

const sweep = (address: string, txid = `sweep-of-${address}`): Transfer => ({ kind: "gas_sweep", to: GAS_WALLET, amount: 428_150n, txid });

type AfterPayout = (request: AfterPayoutRequest) => Promise<AfterPayoutResult>;

const LATE = 20_000_000n;

/**
 * A chain whose payout saves its plan on the first call and proves it on the
 * next: F1 at 5% with a network cost of 1 USDT, on the invoice amount (the
 * merchant payout) or on LATE (a refund route). `afterPayout` is the work
 * after a proven payout; omit it for a chain that has none (EVM, TON, BTC).
 * Other tests' invoices on the same database get "pending" from both.
 */
function fakeChain(deposit: string, afterPayout?: AfterPayout) {
  const payments = new Map<string, ChainPayment[]>();
  const afterCalls: AfterPayoutRequest[] = [];
  const payoutCalls: PayoutRequest[] = [];
  const adapter: ChainAdapter = {
    asset: "usdttrx",
    requiredConfirmations: 1,
    isValidAddress: (address) => address.startsWith("merchant-"),
    canPayOutAs: (receive) => receive === "usdttrx",
    newDeposit: async () => {
      throw new Error("not used by the watcher");
    },
    getPayments: async (address) => [...(payments.get(address) ?? [])],
    estimateNetworkCost: async () => 1_000_000n,
    payout: async (request): Promise<PayoutResult> => {
      if (request.depositAddress !== deposit) return { status: "pending", reason: "not this test's" };
      payoutCalls.push(request);
      if (request.checkpoint) return { status: "paid", transfers: request.checkpoint.plan.transfers };
      const txid = `${request.destinationKind}-of-${request.depositAddress}`;
      const received = request.destinationKind === "refund_route" ? LATE : AMOUNT;
      const fee = received / 20n;
      const plan = {
        transfers: [
          { kind: "gas_top_up" as const, to: request.depositAddress, amount: 5_000_000n, txid: `top-up-${txid}` },
          { kind: request.destinationKind, to: request.destination, amount: received - fee - 1_000_000n, txid },
          { kind: "platform_fee" as const, to: "platform", amount: fee + 1_000_000n, txid: `fee-${txid}` },
        ],
        platformFee: fee,
        networkCost: 1_000_000n,
      };
      const saved = await request.saveCheckpoint({ state: `payout-state-${txid}`, plan });
      return { status: "pending", reason: saved ? "sent" : "another run saved first" };
    },
    ...(afterPayout && {
      afterPayout: async (request: AfterPayoutRequest): Promise<AfterPayoutResult> => {
        if (request.depositAddress !== deposit) return { status: "pending", reason: "not this test's" };
        afterCalls.push(request);
        return await afterPayout(request);
      },
    }),
  };
  return {
    adapter,
    afterCalls,
    payoutCalls,
    pay: (payment: ChainPayment) => payments.set(deposit, [...(payments.get(deposit) ?? []), payment]),
    ports: (now: number): WatcherPorts => ({ now: () => now, chains: { usdttrx: adapter }, swap: unusedSwap() }),
  };
}

async function invoiceNow(invoiceId: string) {
  return await db
    .collection("invoices")
    .findOne({ invoice_id: invoiceId }, { projection: { _id: 0, private: 0 } });
}

type Stored = { kind: string; to: string; amount: string; txid: string; status: string; payout?: number };
const transfersOf = (invoice: Record<string, unknown> | null) =>
  ((invoice?.transfers ?? []) as Stored[]).map((t) => [t.kind, t.status, ...(t.payout === undefined ? [] : [t.payout])]);

/** Passes a minute apart, from `from`. */
async function passes(chain: ReturnType<typeof fakeChain>, from: number, count: number) {
  for (let i = 0; i < count; i += 1) await runWatcherPass(chain.ports(from + i * MINUTE));
}

describe("work after a proven payout (the Tron gas sweep)", () => {
  it("completes the invoice as soon as the payout is proven, while the work after it is still pending", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    const chain = fakeChain(address, async () => ({ status: "pending", reason: "gas sweep sent; waiting for it to be solidified" }));

    await passes(chain, NOW, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.timestamps?.completed, NOW + MINUTE);
    assert.deepEqual(invoice?.status_log, [
      { from: "confirmed", to: "processing", at: NOW },
      { from: "processing", to: "completed", at: NOW + MINUTE },
    ]);
    assert.equal(invoice?.received_amount, "94000000");
    assert.deepEqual(transfersOf(invoice), [
      ["gas_top_up", "confirmed"],
      ["merchant_payout", "confirmed"],
      ["platform_fee", "confirmed"],
    ]);
    assert.equal(invoice?.after_payout_pending, true);
    const calls = chain.afterCalls;
    assert.equal(calls.length, 1, "asked in the pass that completed the invoice");
    assert.equal(calls[0]!.state, `payout-state-merchant_payout-of-${address}`);
    assert.equal(calls[0]!.depositKey.kind, "sealed_key");
  });

  it("records the sweep once it lands, leaves the completed invoice as it was, and stops asking", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    let landed = false;
    const chain = fakeChain(address, async (request) =>
      landed ? { status: "done", transfers: [sweep(request.depositAddress)] } : { status: "pending", reason: "sent" },
    );
    await passes(chain, NOW, 2);
    const completed = await invoiceNow(invoiceId);

    landed = true;
    await passes(chain, NOW + 2 * MINUTE, 3);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(chain.afterCalls.length, 2, "not asked again once done");
    assert.equal(invoice?.status, "completed");
    assert.deepEqual(invoice?.status_log, completed?.status_log, "no status change");
    assert.deepEqual(invoice?.timestamps, completed?.timestamps);
    assert.equal(invoice?.received_amount, completed?.received_amount);
    assert.equal(invoice?.after_payout_pending, false);
    assert.deepEqual(transfersOf(invoice), [
      ["gas_top_up", "confirmed"],
      ["merchant_payout", "confirmed"],
      ["platform_fee", "confirmed"],
      ["gas_sweep", "confirmed"],
    ]);
    assert.deepEqual(
      (invoice?.transfers as Stored[]).at(-1),
      { kind: "gas_sweep", to: GAS_WALLET, amount: "428150", txid: `sweep-of-${address}`, status: "confirmed" },
    );
  });

  it("hands each pass the state the work saved last, and lets only one of two overlapping runs save", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    let racing = false;
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => (release = resolve));
    const outcomes: boolean[] = [];
    const chain = fakeChain(address, async (request) => {
      if (!racing) return { status: "pending", reason: "Tron node lookups failed" };
      if (request.state.startsWith("payout-state")) {
        const run = ++arrived;
        if (run === 2) release();
        await bothArrived;
        const saved = await request.saveState(`sweep-signed-by-run-${run}`);
        outcomes.push(saved);
        return { status: "pending", reason: saved ? "sent" : "another run saved first" };
      }
      return { status: "done", transfers: [sweep(request.depositAddress, request.state)] };
    });
    await passes(chain, NOW, 2);
    assert.equal((await invoiceNow(invoiceId))?.status, "completed");

    racing = true;
    await Promise.all([runWatcherPass(chain.ports(NOW + 2 * MINUTE)), runWatcherPass(chain.ports(NOW + 2 * MINUTE))]);

    assert.deepEqual(outcomes.sort(), [false, true]);
    const stored = await db.collection("invoices").findOne({ invoice_id: invoiceId }, { projection: { "tx.raw": 1 } });
    assert.match(stored?.tx?.raw ?? "", /^sweep-signed-by-run-[12]$/);

    await passes(chain, NOW + 3 * MINUTE, 2);

    const invoice = await invoiceNow(invoiceId);
    const sweeps = (invoice?.transfers as Stored[]).filter((t) => t.kind === "gas_sweep");
    assert.deepEqual(sweeps.map((t) => t.txid), [stored?.tx?.raw], "the saved sweep, recorded once");
    assert.equal(invoice?.status, "completed");
  });

  it("saves each state after the run's own last one, and refuses a save once another run saved first", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    const results: boolean[] = [];
    const chain = fakeChain(address, async (request) => {
      results.push(await request.saveState("first"));
      results.push(await request.saveState("second"));
      await db.collection("invoices").updateOne({ invoice_id: invoiceId }, { $set: { "tx.raw": "another run's" } });
      results.push(await request.saveState("third"));
      return { status: "pending", reason: "sent" };
    });

    await passes(chain, NOW, 2);

    assert.deepEqual(results, [true, true, false]);
    const stored = await db.collection("invoices").findOne({ invoice_id: invoiceId }, { projection: { "tx.raw": 1 } });
    assert.equal(stored?.tx?.raw, "another run's");
    assert.equal(chain.afterCalls.length, 1);
  });

  it("does the work on a later pass after a crash between the completion and the sweep, exactly once", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    let crash = true;
    const chain = fakeChain(address, async (request) => {
      if (crash) throw new Error("process killed");
      return { status: "done", transfers: [sweep(request.depositAddress)] };
    });
    await passes(chain, NOW, 2);
    assert.equal((await invoiceNow(invoiceId))?.status, "completed");
    assert.equal((await invoiceNow(invoiceId))?.after_payout_pending, true);

    crash = false;
    await passes(chain, NOW + 2 * MINUTE, 2);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(chain.afterCalls.length, 2);
    assert.equal((invoice?.transfers as Stored[]).filter((t) => t.kind === "gas_sweep").length, 1);
    assert.equal(invoice?.after_payout_pending, false);
  });

  it("never touches the merchant payout when the work after it keeps failing", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    const chain = fakeChain(address, async () => {
      throw new Error("Tron node down");
    });

    await passes(chain, NOW, 6);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.review_reason, "");
    assert.equal(invoice?.received_amount, "94000000");
    assert.deepEqual(transfersOf(invoice), [
      ["gas_top_up", "confirmed"],
      ["merchant_payout", "confirmed"],
      ["platform_fee", "confirmed"],
    ]);
  });

  it("marks nothing for a chain with no work after a payout (EVM, TON, BTC)", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    const chain = fakeChain(address);

    await passes(chain, NOW, 3);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.notEqual(invoice?.after_payout_pending, true);
  });

  it("starts no refund route while the sweep before it is pending: the route would count TRX the sweep takes", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    let landed = false;
    const chain = fakeChain(address, async (request) =>
      landed ? { status: "done", transfers: [sweep(request.depositAddress)] } : { status: "pending", reason: "sent" },
    );
    chain.pay({ txid: "tx-paid", amount: AMOUNT, confirmations: 1, seenAt: NOW - 5 * MINUTE });
    await passes(chain, NOW, 2);
    chain.pay({ txid: "tx-late", amount: LATE, confirmations: 1, seenAt: NOW + 3 * MINUTE });

    await runWatcherPass(chain.ports(NOW + 10 * MINUTE));
    await runWatcherPass(chain.ports(NOW + 16 * MINUTE));

    assert.deepEqual(chain.payoutCalls.filter((r) => r.destinationKind === "refund_route"), [], "no route while the sweep is pending");
    assert.deepEqual((await invoiceNow(invoiceId))?.refund_routes ?? [], []);

    landed = true;
    await runWatcherPass(chain.ports(NOW + 17 * MINUTE));
    await runWatcherPass(chain.ports(NOW + 23 * MINUTE));

    assert.equal(chain.payoutCalls.filter((r) => r.destinationKind === "refund_route").length, 1, "the route starts once the sweep is done");
    assert.equal((await invoiceNow(invoiceId))?.status, "completed");
  });

  it("follows a refund route the same way: the route is paid at once, and its sweep is recorded under it", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    let landed = false;
    const chain = fakeChain(address, async (request) =>
      landed ? { status: "done", transfers: [sweep(request.depositAddress, `route-sweep-${request.state}`)] } : { status: "pending", reason: "sent" },
    );
    chain.pay({ txid: "tx-paid", amount: AMOUNT, confirmations: 1, seenAt: NOW - 5 * MINUTE });
    await passes(chain, NOW, 2);
    landed = true;
    await passes(chain, NOW + 2 * MINUTE, 1);
    landed = false;

    // Late money, routed to the refund address.
    chain.pay({ txid: "tx-late", amount: LATE, confirmations: 1, seenAt: NOW + 3 * MINUTE });
    const late = NOW + 10 * MINUTE;
    await runWatcherPass(chain.ports(late));
    await runWatcherPass(chain.ports(late + 6 * MINUTE));

    let invoice = await invoiceNow(invoiceId);
    const routes = invoice?.refund_routes as { n: number; state: string; after_payout_pending?: boolean }[];
    assert.equal(routes[0]?.state, "paid");
    assert.equal(routes[0]?.after_payout_pending, true);
    assert.equal(invoice?.status, "completed");

    landed = true;
    await runWatcherPass(chain.ports(late + 7 * MINUTE));

    invoice = await invoiceNow(invoiceId);
    assert.equal((invoice?.refund_routes as { after_payout_pending?: boolean }[])[0]?.after_payout_pending, false);
    assert.deepEqual(transfersOf(invoice), [
      ["gas_top_up", "confirmed"],
      ["merchant_payout", "confirmed"],
      ["platform_fee", "confirmed"],
      ["gas_sweep", "confirmed"],
      ["gas_top_up", "confirmed", 1],
      ["refund_route", "confirmed", 1],
      ["platform_fee", "confirmed", 1],
      ["gas_sweep", "confirmed", 1],
    ]);
    const routeSweep = (invoice?.transfers as Stored[]).at(-1);
    assert.equal(routeSweep?.txid, "route-sweep-payout-state-refund_route-of-" + address, "the route's own saved state");
    assert.equal(invoice?.status, "completed");
  });
});
