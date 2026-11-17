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
import { parseFeeRate, payerPaysAskedAmount, splitPayout } from "../../src/money/payout-split.js";

// One watcher pass, with the clock and the chains faked at the registry seam.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const NOW = Date.parse("2026-11-17T12:00:00Z");
const MINUTE = 60_000;
const AMOUNT = 100_000n; // satoshi the invoice asks for
const MERCHANT_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const EXPIRES_AT = NOW + 25 * MINUTE; // created 5 minutes before NOW, lifetime 30
const AFTER_EXPIRY = NOW + 26 * MINUTE;

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
    to_address: MERCHANT_ADDRESS,
    amount: AMOUNT.toString(),
    amount_fiat: "2500",
    paid_amount: "0",
    address,
    lifetime: 30,
    fee_rate: "0.05",
    timestamps: { created: NOW - 5 * MINUTE, waiting: NOW - 5 * MINUTE },
    private: { private_key: sealedKey() },
    ...fields,
  });
  return { invoiceId, address };
}

let txCounter = 0;
function payment(amount: bigint, fields: Partial<ChainPayment> = {}): ChainPayment {
  txCounter += 1;
  return { txid: `tx-${txCounter}`, amount, confirmations: 0, ...fields };
}
const unconfirmed = (amount: bigint, fields: Partial<ChainPayment> = {}) => payment(amount, fields);
const confirmed = (amount: bigint, fields: Partial<ChainPayment> = {}) =>
  payment(amount, { confirmations: 1, ...fields });

type Chain = Map<string, ChainPayment[] | "lookup fails">;
type FakePayout = (request: PayoutRequest) => Promise<PayoutResult>;

/** An adapter whose chain is `chain` (payments per deposit address). */
function fakeAdapter(asset: "btc" | "ton", chain: Chain, payout: FakePayout, calls: PayoutRequest[]): ChainAdapter {
  return {
    asset,
    requiredConfirmations: 1,
    isValidAddress: (address) => address === MERCHANT_ADDRESS || address.startsWith("merchant-"),
    canPayOutAs: (receive) => receive === asset || (asset === "btc" && receive === "usdceth"),
    newDeposit: async () => {
      throw new Error("not used by the watcher");
    },
    getPayments: async (address) => {
      const payments = chain.get(address);
      if (payments === "lookup fails") return undefined;
      return payments ?? [];
    },
    estimateNetworkCost: async () => 0n,
    payout: async (request) => {
      calls.push(request);
      return await payout(request);
    },
  };
}

const stillPending: FakePayout = async () => ({ status: "pending", reason: "fake" });

/** Fake ports: `chain` says what each deposit address has received. */
function fakePorts(chain: Chain, now = NOW, payout: FakePayout = stillPending) {
  const payoutCalls: PayoutRequest[] = [];
  const swapsFollowed: string[] = [];
  const ports: WatcherPorts = {
    now: () => now,
    chains: {
      btc: fakeAdapter("btc", chain, payout, payoutCalls),
      ton: fakeAdapter("ton", chain, payout, payoutCalls),
    },
    followSwap: async (invoiceId) => {
      swapsFollowed.push(invoiceId);
    },
  };
  const paidOut = () => payoutCalls.map((request) => request.depositAddress);
  return { ports, payoutCalls, paidOut, swapsFollowed };
}

async function invoiceNow(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

describe("a watcher pass over a fixed-coin BTC invoice", () => {
  it("keeps waiting while nothing has been paid", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, []]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "waiting");
    assert.ok(!paidOut().includes(address));
  });

  it("marks a full but unconfirmed payment as confirming, and pays nothing out", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, [unconfirmed(AMOUNT)]]]));

    await runWatcherPass(ports);
    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirming");
    assert.ok(!paidOut().includes(address));
  });

  it("confirms a confirmed payment, then pays it out on the next pass", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, [confirmed(AMOUNT)]]]));

    await runWatcherPass(ports);
    const afterFirst = await invoiceNow(invoiceId);
    assert.equal(afterFirst?.status, "confirmed");
    assert.equal(afterFirst?.paid_amount, AMOUNT.toString());
    assert.equal(afterFirst?.timestamps?.confirmed, NOW);
    assert.ok(!paidOut().includes(address), "paid out in the same pass it was confirmed");

    await runWatcherPass(ports);
    assert.deepEqual(paidOut().filter((a) => a === address), [address]);
  });

  it("treats an overpayment as paid", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, [confirmed(AMOUNT + 50_000n)]]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirmed");
  });

  it("records a partial payment as underpaid", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, [confirmed(40_000n)]]]));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "underpaid");
    assert.equal(invoice?.paid_amount, "40000");
    assert.ok(!paidOut().includes(address));
  });

  it("expires an unpaid invoice once its lifetime is over, and never pays it out", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, []]]), AFTER_EXPIRY);

    await runWatcherPass(ports);
    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.equal(invoice?.timestamps?.expired, AFTER_EXPIRY);
    assert.ok(!paidOut().includes(address));
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

  it("expires an unpaid invoice with no outcome to handle", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, []]]), AFTER_EXPIRY);

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.ok(!invoice?.outcome);
  });

  it("leaves an invoice alone when its coin has no adapter", async () => {
    const { invoiceId, address } = await btcInvoice({ crypto: "ltc", to_crypto: "ltc" });
    const { ports } = fakePorts(new Map([[address, [confirmed(AMOUNT)]]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "waiting");
  });
});

describe("recording payments", () => {
  it("records each payment with its amount, confirmations, and the time the watcher first saw it", async () => {
    const { invoiceId, address } = await btcInvoice();
    const a = confirmed(30_000n, { txid: "tx-a" });
    const b = unconfirmed(20_000n, { txid: "tx-b" });
    const { ports } = fakePorts(new Map([[address, [a, b]]]));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.deepEqual(invoice?.payments, [
      { txid: "tx-a", amount: "30000", first_seen_at: NOW, confirmations: 1, on_time: true },
      { txid: "tx-b", amount: "20000", first_seen_at: NOW, confirmations: 0, on_time: true },
    ]);
    assert.equal(invoice?.tx?.in, "tx-a");
  });

  it("takes the provider's time when it is earlier than the watcher's first look", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, [unconfirmed(1_000n, { seenAt: NOW - 2 * MINUTE })]]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.payments?.[0]?.first_seen_at, NOW - 2 * MINUTE);
  });

  it("never takes a provider time later than the watcher's first look", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, [unconfirmed(1_000n, { seenAt: NOW + MINUTE })]]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.payments?.[0]?.first_seen_at, NOW);
  });

  it("keeps the earliest first-seen time when a later pass sees a later block time", async () => {
    const { invoiceId, address } = await btcInvoice();
    const inMempool = unconfirmed(1_000n, { txid: "tx-mined-later" });
    await runWatcherPass(fakePorts(new Map([[address, [inMempool]]]), NOW).ports);

    const mined = { ...inMempool, confirmations: 1, seenAt: NOW + 10 * MINUTE };
    await runWatcherPass(fakePorts(new Map([[address, [mined]]]), NOW + 11 * MINUTE).ports);

    const recorded = (await invoiceNow(invoiceId))?.payments?.[0];
    assert.equal(recorded?.first_seen_at, NOW);
    assert.equal(recorded?.confirmations, 1);
  });

  it("adds up several payments", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, [confirmed(60_000n), confirmed(40_000n)]]]));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "confirmed");
    assert.equal(invoice?.paid_amount, AMOUNT.toString());
  });

  it("waits for every part to be confirmed", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, [confirmed(60_000n), unconfirmed(40_000n)]]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirming");
  });

  it("drops a payment the chain no longer shows (replaced before it confirmed)", async () => {
    const { invoiceId, address } = await btcInvoice();
    await runWatcherPass(fakePorts(new Map([[address, [unconfirmed(40_000n)]]])).ports);
    assert.equal((await invoiceNow(invoiceId))?.paid_amount, "40000");

    await runWatcherPass(fakePorts(new Map([[address, []]])).ports);

    const invoice = await invoiceNow(invoiceId);
    assert.deepEqual(invoice?.payments, []);
    assert.equal(invoice?.paid_amount, "0");
  });
});

describe("the on-time rule at expiry", () => {
  it("counts a payment the provider saw before expiry as on time, though the watcher first looks after", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(
      new Map([[address, [unconfirmed(AMOUNT, { seenAt: EXPIRES_AT - 1_000 })]]]),
      AFTER_EXPIRY,
    );

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "confirming");
    assert.equal(invoice?.payments?.[0]?.on_time, true);
  });

  it("counts a payment first seen after expiry as late: it pays nothing, and the invoice expires", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports, paidOut } = fakePorts(new Map([[address, [confirmed(AMOUNT)]]]), AFTER_EXPIRY);

    await runWatcherPass(ports);
    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.ok(!invoice?.outcome);
    assert.equal(invoice?.paid_amount, "0");
    assert.equal(invoice?.payments?.[0]?.on_time, false);
    assert.equal(invoice?.payments?.[0]?.first_seen_at, AFTER_EXPIRY);
    assert.ok(!paidOut().includes(address));
  });

  it("counts a payment seen exactly at expiry as late", async () => {
    const { invoiceId, address } = await btcInvoice();
    const { ports } = fakePorts(new Map([[address, [confirmed(AMOUNT, { seenAt: EXPIRES_AT })]]]), AFTER_EXPIRY);

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "expired");
  });

  it("expires an underpaid invoice as partially paid, counting only the on-time part", async () => {
    const { invoiceId, address } = await btcInvoice();
    const onTime = confirmed(40_000n, { seenAt: NOW });
    const late = confirmed(60_000n);
    const { ports } = fakePorts(new Map([[address, [onTime, late]]]), AFTER_EXPIRY);

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "expired");
    assert.equal(invoice?.outcome, "partially_paid");
    assert.equal(invoice?.paid_amount, "40000");
    assert.deepEqual(invoice?.payments?.map((p: { on_time: boolean }) => p.on_time), [true, false]);
  });
});

describe("paying out", () => {
  /** A confirmed invoice, paid in one transaction. */
  async function confirmedInvoice(fields: Record<string, unknown> = {}) {
    return await btcInvoice({
      status: "confirmed",
      paid_amount: AMOUNT.toString(),
      timestamps: { created: NOW - 5 * MINUTE, waiting: NOW - 5 * MINUTE, confirmed: NOW - MINUTE },
      ...fields,
    });
  }

  const PLAN = {
    transfers: [
      { kind: "merchant_payout" as const, to: MERCHANT_ADDRESS, amount: 92_000n, txid: "payout-tx" },
      { kind: "platform_fee" as const, to: "platform", amount: 5_000n, txid: "payout-tx" },
    ],
    platformFee: 5_000n,
    networkCost: 3_000n,
  };

  /** Saves PLAN on the first call, then proves it on the next. */
  const checkpointThenPaid: FakePayout = async (request) => {
    if (!request.checkpoint) {
      const saved = await request.saveCheckpoint({ state: "signed-tx", plan: PLAN });
      return { status: "pending", reason: saved ? "broadcast" : "lost the race" };
    }
    return { status: "paid", transfers: request.checkpoint.plan.transfers };
  };

  it("asks the adapter to pay the invoice's destination at the invoice's own fee rate", async () => {
    const { address } = await confirmedInvoice({ fee_rate: "0.01", underpaid: 5 });
    const { ports, payoutCalls } = fakePorts(new Map());

    await runWatcherPass(ports);

    const request = payoutCalls.find((r) => r.depositAddress === address);
    assert.ok(request);
    assert.equal(request.destination, MERCHANT_ADDRESS);
    assert.equal(request.destinationKind, "merchant_payout");
    assert.equal(request.receiveAsset, "btc");
    assert.equal(request.feeRate, parseFeeRate("0.01"));
    assert.equal(request.minimumAmount, 95_000n);
    assert.equal(request.depositKey.kind, "sealed_key");
    assert.equal(request.checkpoint, undefined);
  });

  it("uses the merchant's current rate for an invoice made before rates were copied", async () => {
    const userId = randomUUID();
    userIds.push(userId);
    await db.collection("users").insertOne({ user_id: userId, merchant_fee: "0.02" });
    const { address } = await confirmedInvoice({ user_id: userId, fee_rate: undefined });
    const { ports, payoutCalls } = fakePorts(new Map());

    await runWatcherPass(ports);

    assert.equal(payoutCalls.find((r) => r.depositAddress === address)?.feeRate, parseFeeRate("0.02"));
  });

  it("saves the checkpoint as processing, with the planned transfers, before anything is sent", async () => {
    const { invoiceId } = await confirmedInvoice();
    const { ports } = fakePorts(new Map(), NOW, checkpointThenPaid);

    await runWatcherPass(ports);

    const invoice = await db
      .collection("invoices")
      .findOne({ invoice_id: invoiceId }, { projection: { status: 1, transfers: 1, tx: 1, platform_fee: 1, network_fee: 1, received_amount: 1, timestamps: 1 } });
    assert.equal(invoice?.status, "processing");
    assert.equal(invoice?.timestamps?.processing, NOW);
    assert.equal(invoice?.tx?.raw, "signed-tx");
    assert.equal(invoice?.tx?.out, "payout-tx");
    assert.equal(invoice?.tx?.platform_out, "payout-tx");
    assert.equal(invoice?.platform_fee, "5000");
    assert.equal(invoice?.network_fee, "3000");
    assert.equal(invoice?.received_amount, "92000");
    assert.deepEqual(invoice?.transfers, [
      { kind: "merchant_payout", to: MERCHANT_ADDRESS, amount: "92000", txid: "payout-tx", status: "pending" },
      { kind: "platform_fee", to: "platform", amount: "5000", txid: "payout-tx", status: "pending" },
    ]);
  });

  it("hands the saved checkpoint back, and records the proof as completed", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    const first = fakePorts(new Map(), NOW, checkpointThenPaid);
    await runWatcherPass(first.ports);
    const second = fakePorts(new Map(), NOW + MINUTE, checkpointThenPaid);

    await runWatcherPass(second.ports);

    const checkpoint = second.payoutCalls.find((r) => r.depositAddress === address)?.checkpoint;
    assert.deepEqual(checkpoint, { state: "signed-tx", plan: PLAN });
    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.timestamps?.completed, NOW + MINUTE);
    assert.deepEqual(
      invoice?.transfers?.map((t: { status: string }) => t.status),
      ["confirmed", "confirmed"],
    );
  });

  it("lets only one of two overlapping runs save a checkpoint", async () => {
    const { invoiceId, address } = await confirmedInvoice();
    const outcomes: boolean[] = [];
    let release!: () => void;
    const bothPrepared = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    const racing: FakePayout = async (request) => {
      if (request.depositAddress !== address) return { status: "pending", reason: "not this test's" };
      const run = ++waiting;
      if (run === 2) release();
      await bothPrepared;
      outcomes.push(await request.saveCheckpoint({ state: `signed-by-run-${run}`, plan: PLAN }));
      return { status: "pending", reason: "race" };
    };

    await Promise.all([
      runWatcherPass(fakePorts(new Map(), NOW, racing).ports),
      runWatcherPass(fakePorts(new Map(), NOW, racing).ports),
    ]);

    assert.deepEqual(outcomes.sort(), [false, true]);
    assert.equal((await invoiceNow(invoiceId))?.status, "processing");
  });

  it("marks a failed payout failed, keeping where-the-money-is message", async () => {
    const { invoiceId } = await confirmedInvoice();
    const message = "Payout stopped: the merchant can't receive. All funds are still at deposit address X.";
    const { ports } = fakePorts(new Map(), NOW, async () => ({ status: "failed", message, transfers: [] }));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.equal(invoice?.review_reason, message);
    assert.equal(invoice?.timestamps?.failed, NOW);
  });

  it("marks the planned transfers failed and records what really moved", async () => {
    const { invoiceId } = await confirmedInvoice();
    await runWatcherPass(fakePorts(new Map(), NOW, checkpointThenPaid).ports);
    const moved = { kind: "platform_fee" as const, to: "platform", amount: 97_000n, txid: "landed-tx" };
    const { ports } = fakePorts(new Map(), NOW, async () => ({ status: "failed", message: "landed but did not pay", transfers: [moved] }));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.deepEqual(
      invoice?.transfers?.map((t: { txid: string; status: string; amount: string }) => [t.txid, t.amount, t.status]),
      [["payout-tx", "92000", "failed"], ["payout-tx", "5000", "failed"], ["landed-tx", "97000", "confirmed"]],
    );
  });

  it("keeps the invoice confirmed when the deposit is too small to forward", async () => {
    const { invoiceId } = await confirmedInvoice();
    const { ports } = fakePorts(new Map(), NOW, async () => ({ status: "too_small", reason: "fees exceed it" }));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirmed");
  });

  it("writes an adapter's review note without changing the status", async () => {
    const { invoiceId } = await confirmedInvoice();
    const { ports } = fakePorts(new Map(), NOW, async () => ({ status: "pending", reason: "odd", review: "Check the deposit on an explorer." }));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "confirmed");
    assert.equal(invoice?.review_reason, "Check the deposit on an explorer.");
  });

  it("notes a payout still pending a day after it was saved", async () => {
    const { invoiceId } = await confirmedInvoice();
    await runWatcherPass(fakePorts(new Map(), NOW, checkpointThenPaid).ports);
    const later = NOW + 25 * 60 * MINUTE;
    const { ports } = fakePorts(new Map(), later, async () => ({ status: "pending", reason: "not landed yet" }));

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "processing");
    assert.match(invoice?.review_reason ?? "", /24 hours.*not landed yet.*deposit-/);
  });

  it("fails without calling the adapter when the deposit key is missing", async () => {
    const { invoiceId, address } = await confirmedInvoice({ private: {} });
    const { ports, paidOut } = fakePorts(new Map());

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.match(invoice?.review_reason ?? "", new RegExp(`key is missing.*${address}`));
    assert.ok(!paidOut().includes(address));
  });

  it("fails without calling the adapter when the destination is not a valid address", async () => {
    const { invoiceId, address } = await confirmedInvoice({ to_address: "not-an-address" });
    const { ports, paidOut } = fakePorts(new Map());

    await runWatcherPass(ports);

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.match(invoice?.review_reason ?? "", new RegExp(`not-an-address.*${address}`));
    assert.ok(!paidOut().includes(address));
  });

  it("keeps going when one invoice's payout throws", async () => {
    const first = await confirmedInvoice();
    const second = await confirmedInvoice();
    const { ports, paidOut } = fakePorts(new Map(), NOW, async (request) => {
      if (request.depositAddress === first.address) throw new Error("node down");
      return { status: "pending", reason: "fake" };
    });

    await runWatcherPass(ports);

    assert.ok(paidOut().includes(first.address) && paidOut().includes(second.address));
  });

  it("keeps going when one chain's adapter throws", async () => {
    const onBtc = await btcInvoice();
    const onTon = await btcInvoice({ crypto: "ton", to_crypto: "ton", to_address: "merchant-ton" });
    const { ports } = fakePorts(new Map([[onTon.address, [confirmed(AMOUNT)]]]));
    ports.chains.btc!.getPayments = async () => {
      throw new Error("bitcoin node down");
    };

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(onBtc.invoiceId))?.status, "waiting");
    assert.equal((await invoiceNow(onTon.invoiceId))?.status, "confirmed");
  });

  describe("a legacy swap (BTC deposit, USDC payout)", () => {
    const SWAP_PLAN = {
      transfers: [{ kind: "swap_deposit" as const, to: "near-deposit", amount: 92_000n, txid: "swap-tx" }],
      platformFee: 5_000n,
      networkCost: 3_000n,
      legacySwap: { depositAddress: "near-deposit", deadline: "2026-11-18T12:00:00Z", quote: { quote: { minAmountOut: "1" } } },
    };
    const swapPayout: FakePayout = async (request) => {
      if (!request.checkpoint) {
        await request.saveCheckpoint({ state: "signed-swap-tx", plan: SWAP_PLAN });
        return { status: "pending", reason: "broadcast" };
      }
      return { status: "paid", transfers: request.checkpoint.plan.transfers };
    };

    it("stays processing once the deposit reached NEAR, and only follows the swap after that", async () => {
      const { invoiceId, address } = await confirmedInvoice({ to_crypto: "usdceth", to_address: "0x000000000000000000000000000000000000dEaD" });

      await runWatcherPass(fakePorts(new Map(), NOW, swapPayout).ports);
      const saved = await invoiceNow(invoiceId);
      assert.equal(saved?.swap?.deposit_address, "near-deposit");
      assert.equal(saved?.swap?.status, "PENDING_DEPOSIT");
      assert.equal(saved?.received_amount, "0");

      await runWatcherPass(fakePorts(new Map(), NOW, swapPayout).ports);
      assert.equal((await invoiceNow(invoiceId))?.status, "processing");

      const third = fakePorts(new Map(), NOW, swapPayout);
      await runWatcherPass(third.ports);
      assert.ok(!third.paidOut().includes(address), "asked the adapter again after its proof");
      assert.ok(third.swapsFollowed.includes(invoiceId));
    });
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
    const { ports } = fakePorts(new Map([[address, [confirmed(95_000n)]]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "confirmed");
  });

  it("refuses a payment one unit short of the tolerance", async () => {
    const { invoiceId, address } = await btcInvoice({ underpaid: 5 });
    const { ports } = fakePorts(new Map([[address, [confirmed(94_999n)]]]));

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
        [short.address, [confirmed(97_500n)]],
        [enough.address, [confirmed(97_501n)]],
      ]),
    );

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(short.invoiceId))?.status, "underpaid");
    assert.equal((await invoiceNow(enough.invoiceId))?.status, "confirmed");
  });

  it("asks for the full amount when there is no tolerance", async () => {
    const { invoiceId, address } = await btcInvoice({ underpaid: 0 });
    const { ports } = fakePorts(new Map([[address, [confirmed(AMOUNT - 1n)]]]));

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
   * A chain whose payout really costs `realNetworkCost`: it splits whatever
   * the deposit holds by F1 at the rate the watcher hands it, as every
   * chain's payout does.
   */
  function settlingPorts(chain: Chain, realNetworkCost: bigint) {
    const merchantGot = new Map<string, bigint>();
    const { ports } = fakePorts(chain, NOW, async (request) => {
      const held = chain.get(request.depositAddress);
      if (held === undefined || held === "lookup fails") return { status: "pending", reason: "fake" };
      const received = held.reduce((sum, p) => sum + p.amount, 0n);
      const split = splitPayout({ received, networkCost: realNetworkCost, feeRate: request.feeRate });
      if (split !== undefined) merchantGot.set(request.depositAddress, split.merchantAmount);
      return { status: "pending", reason: "fake" };
    });
    return { merchantGot, ports };
  }

  it("asks for an amount that pays the merchant the invoice amount at the estimated cost", () => {
    assert.equal(payerPaysAskedAmount({ invoiceAmount: BASE, estimatedNetworkCost: ESTIMATE, feeRate: FEE_RATE }), ASKED);
  });

  it("is paid by exactly the asked amount, and the merchant gets the invoice amount when the cost is as estimated", async () => {
    const { invoiceId, address } = await payerPaysInvoice();
    const s = settlingPorts(new Map([[address, [confirmed(ASKED)]]]), ESTIMATE);

    await runWatcherPass(s.ports);
    assert.equal((await invoiceNow(invoiceId))?.status, "confirmed");
    await runWatcherPass(s.ports);

    // fee = ceil(5,391.6) = 5,392; 107,832 − 5,392 − 2,440 = 100,000
    assert.equal(s.merchantGot.get(address), BASE);
  });

  it("is not paid by the invoice amount alone", async () => {
    const { invoiceId, address } = await payerPaysInvoice();
    const { ports } = fakePorts(new Map([[address, [confirmed(BASE)]]]));

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(invoiceId))?.status, "underpaid");
  });

  it("applies the tolerance to the asked amount", async () => {
    // 1% of 107,832 is 1,078.32: at least 107,832 − 1,078 = 106,754
    const enough = await payerPaysInvoice({ underpaid: 1 });
    const short = await payerPaysInvoice({ underpaid: 1 });
    const chain: Chain = new Map([
      [enough.address, [confirmed(106_754n)]],
      [short.address, [confirmed(106_753n)]],
    ]);
    const s = settlingPorts(chain, ESTIMATE);

    await runWatcherPass(s.ports);
    assert.equal((await invoiceNow(enough.invoiceId))?.status, "confirmed");
    assert.equal((await invoiceNow(short.invoiceId))?.status, "underpaid");
    await runWatcherPass(s.ports);

    // The tolerance is the merchant's: fee = ceil(5,337.7) = 5,338;
    // 106,754 − 5,338 − 2,440 = 98,976
    assert.equal(s.merchantGot.get(enough.address), 98_976n);
  });

  it("leaves the merchant the cost of a network fee above the estimate", async () => {
    const { address } = await payerPaysInvoice();
    const s = settlingPorts(new Map([[address, [confirmed(ASKED)]]]), ESTIMATE + 1_000n);

    await runWatcherPass(s.ports);
    await runWatcherPass(s.ports);

    // 107,832 − 5,392 − 3,440 = 99,000
    assert.equal(s.merchantGot.get(address), BASE - 1_000n);
  });

  it("gives the merchant the saving of a network fee below the estimate", async () => {
    const { address } = await payerPaysInvoice();
    const s = settlingPorts(new Map([[address, [confirmed(ASKED)]]]), ESTIMATE - 1_000n);

    await runWatcherPass(s.ports);
    await runWatcherPass(s.ports);

    // 107,832 − 5,392 − 1,440 = 101,000
    assert.equal(s.merchantGot.get(address), BASE + 1_000n);
  });

  it("checks a TON payment in two parts against the asked amount exactly", async () => {
    // 5 TON invoice, 0.005 TON fee budget, 5%: asked 5,268,421,053 nanoton.
    // Each part is what the chain credited, so a storage fee taken from the
    // balance between the parts does not count against the payer.
    const asked = 5_268_421_053n;
    const ton = { crypto: "ton", to_crypto: "ton", to_address: "merchant-ton", amount: "5000000000", asked_amount: asked.toString() };
    const paid = await payerPaysInvoice(ton);
    const oneShort = await payerPaysInvoice(ton);
    const { ports } = fakePorts(
      new Map([
        [paid.address, [confirmed(5_000_000_000n), confirmed(asked - 5_000_000_000n)]],
        [oneShort.address, [confirmed(5_000_000_000n), confirmed(asked - 5_000_000_001n)]],
      ]),
    );

    await runWatcherPass(ports);

    assert.equal((await invoiceNow(paid.invoiceId))?.status, "confirmed");
    assert.equal((await invoiceNow(oneShort.invoiceId))?.status, "underpaid");
  });
});
