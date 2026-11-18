import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Db } from "mongodb";

import type { ChainAdapter, ChainPayment, PayoutRequest, PayoutResult } from "../../src/chains/adapter.js";
import { connectToMongoDb, disconnectFromMongoDB } from "../../src/infrastructure/database/mongodb.js";
import { runWatcherPass, type WatcherPorts } from "../../src/invoice/invoice.watcher.js";
import { splitPayout } from "../../src/money/payout-split.js";
import { sealSecret } from "../../src/security/secret-envelope.js";
import {
  refundRouteEventId,
  refundRouteSwapEventId,
  runWebhookPass,
  swapEventId,
} from "../../src/webhooks/webhook-pass.js";
import { fakeSwap } from "../helpers/fake-swap.js";

// Swap mode in a watcher pass: a BTC deposit swapped into USDC on Ethereum,
// with the chains and the swap provider faked at their ports.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test.

const NOW = Date.parse("2026-11-18T12:00:00Z");
const MINUTE = 60_000;
const PAID = 100_000n; // satoshi at the deposit
const COST = 1_000n; // the fake BTC payout's network cost
const MERCHANT_USDC = "0x000000000000000000000000000000000000dEaD";
const REFUND_BTC = "merchant-refund-btc";
const PLATFORM = "platform-btc";

let db: Db;
const invoiceIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  db = await connectToMongoDb();
});

// Each pass looks at every open invoice: an earlier test's invoice must not
// meet this test's fakes.
beforeEach(async () => {
  await db.collection("invoices").deleteMany({ invoice_id: { $in: invoiceIds } });
});

after(async () => {
  await db.collection("invoices").deleteMany({ invoice_id: { $in: invoiceIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await db.collection("webhook_events").deleteMany({ invoiceId: { $in: invoiceIds } });
  await disconnectFromMongoDB();
});

function sealedKey() {
  return { keyVersion: 1, initialisationVector: randomBytes(12), authenticationTag: randomBytes(16), ciphertext: randomBytes(32) };
}

async function merchant(addresses: { refund?: Record<string, string>; payout?: Record<string, string> } = {}) {
  const userId = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    merchant_fee: "0.05",
    swap_max_loss_bps: 300,
    payout_addresses: { usdceth: MERCHANT_USDC, ...addresses.payout },
    refund_addresses: addresses.refund ?? {},
  });
  return userId;
}

/** A swap-mode invoice whose BTC payment is confirmed: the next pass pays it into the swap. */
async function confirmedSwapInvoice(userId: string, fields: Record<string, unknown> = {}) {
  const invoiceId = randomUUID();
  invoiceIds.push(invoiceId);
  const address = `deposit-${invoiceId}`;
  await db.collection("invoices").insertOne({
    invoice_id: invoiceId,
    user_id: userId,
    status: "confirmed",
    mode: "swap",
    offered_coins: ["btc", "usdceth"],
    crypto: "btc",
    to_crypto: "usdceth",
    to_address: MERCHANT_USDC,
    amount: PAID.toString(),
    asked_amount: PAID.toString(),
    amount_fiat: "6500",
    paid_amount: PAID.toString(),
    address,
    lifetime: 30,
    fee_rate: "0.05",
    swap_max_loss_bps: 250,
    payments: [{ txid: `pay-${invoiceId}`, amount: PAID.toString(), first_seen_at: NOW - 10 * MINUTE, confirmations: 1, on_time: true }],
    timestamps: { created: NOW - 20 * MINUTE, waiting: NOW - 20 * MINUTE, confirmed: NOW - MINUTE },
    private: { private_key: sealedKey() },
    ...fields,
  });
  return { invoiceId, address, payment: `pay-${invoiceId}` };
}

type Deposit = { payments: ChainPayment[]; spent: Set<string> };

/**
 * A BTC chain whose payout sweeps every confirmed, unspent payment at the
 * deposit with F1 and a network cost of `cost` (estimated as `estimate`),
 * sends nothing before its checkpoint is saved, and sends a saved one once.
 * Plus a USDC chain where the provider's deliveries show up.
 */
function fakeChains(options: { cost?: bigint; estimate?: bigint } = {}) {
  const cost = options.cost ?? COST;
  const deposits = new Map<string, Deposit>();
  const deliveries = new Map<string, ChainPayment[]>();
  const broadcasts: { depositAddress: string; to: string; amount: bigint }[] = [];
  const sent = new Set<string>();
  let crashAfterNextSave = false;
  let counter = 0;

  const deposit = (address: string) => {
    let found = deposits.get(address);
    if (!found) deposits.set(address, (found = { payments: [], spent: new Set() }));
    return found;
  };

  function send(request: PayoutRequest, state: string, plan: { transfers: { to: string; amount: bigint; kind: string }[] }) {
    sent.add(state);
    const held = deposit(request.depositAddress);
    for (const p of held.payments) if (p.confirmations >= 1) held.spent.add(p.txid);
    const destination = plan.transfers[0]!;
    broadcasts.push({ depositAddress: request.depositAddress, to: destination.to, amount: destination.amount });
  }

  async function payout(request: PayoutRequest): Promise<PayoutResult> {
    if (request.checkpoint) {
      if (!sent.has(request.checkpoint.state)) {
        send(request, request.checkpoint.state, request.checkpoint.plan);
        return { status: "pending", reason: "sent the saved transaction" };
      }
      return { status: "paid", transfers: request.checkpoint.plan.transfers };
    }
    const held = deposit(request.depositAddress);
    const unspent = held.payments.filter((p) => p.confirmations >= 1 && !held.spent.has(p.txid));
    const total = unspent.reduce((sum, p) => sum + p.amount, 0n);
    if (total <= 0n || total < request.minimumAmount) return { status: "pending", reason: "deposit below the minimum" };
    const split = splitPayout({ received: total, networkCost: cost, feeRate: request.feeRate });
    if (split === undefined) return { status: "too_small", reason: "fake: too small" };
    counter += 1;
    const txid = `btc-tx-${counter}`;
    const plan = {
      transfers: [
        { kind: request.destinationKind, to: request.destination, amount: split.merchantAmount, txid },
        { kind: "platform_fee" as const, to: PLATFORM, amount: split.platformFee, txid },
      ],
      platformFee: split.platformFee,
      networkCost: cost,
    };
    const state = `signed-${txid}`;
    if (!(await request.saveCheckpoint({ state, plan }))) return { status: "pending", reason: "not saved" };
    if (crashAfterNextSave) {
      crashAfterNextSave = false;
      throw new Error("crashed right after the checkpoint was saved");
    }
    send(request, state, plan);
    return { status: "pending", reason: "broadcast" };
  }

  const btc: ChainAdapter = {
    asset: "btc",
    requiredConfirmations: 1,
    isValidAddress: (address) => address.startsWith("merchant-") || address.startsWith("swap-deposit-"),
    canPayOutAs: (receive) => receive === "btc",
    newDeposit: async () => {
      throw new Error("not used");
    },
    getPayments: async (address) => [...deposit(address).payments],
    estimateNetworkCost: async () => options.estimate ?? cost,
    payout,
  };
  const usdceth: ChainAdapter = {
    asset: "usdceth",
    requiredConfirmations: 1,
    isValidAddress: (address) => address.startsWith("0x"),
    canPayOutAs: (receive) => receive === "usdceth",
    newDeposit: async () => {
      throw new Error("not used");
    },
    getPayments: async (address) => [...(deliveries.get(address) ?? [])],
    estimateNetworkCost: async () => 0n,
    payout: async () => ({ status: "pending", reason: "not used" }),
  };

  return {
    chains: { btc, usdceth },
    broadcasts,
    broadcastsFrom: (address: string) => broadcasts.filter((b) => b.depositAddress === address),
    /** A payment reaches the BTC deposit (the payer, or the provider's refund). */
    pay(address: string, txid: string, amount: bigint) {
      deposit(address).payments.push({ txid, amount, confirmations: 1, seenAt: NOW });
    },
    /** The payer's payment, already confirmed before the test. */
    paid(address: string, txid: string) {
      deposit(address).payments.push({ txid, amount: PAID, confirmations: 1, seenAt: NOW - 10 * MINUTE });
    },
    /** A payment to `address` on the USDC chain; the same txid again updates it. */
    deliver(address: string, txid: string, amount: bigint, confirmations = 1) {
      const others = (deliveries.get(address) ?? []).filter((p) => p.txid !== txid);
      deliveries.set(address, [...others, { txid, amount, confirmations }]);
    },
    crashAfterNextSave() {
      crashAfterNextSave = true;
    },
  };
}

function setUp(options: Parameters<typeof fakeChains>[0] = {}, answer?: Parameters<typeof fakeSwap>[0]["answer"]) {
  let now = NOW;
  const chain = fakeChains(options);
  const swap = fakeSwap({ now: () => now, ...(answer && { answer }) });
  const ports: WatcherPorts = { now: () => now, chains: chain.chains, swap: swap.port };
  return {
    chain,
    swap,
    /** One pass, `minutes` after the previous one (closed invoices are looked at every 5 minutes). */
    async pass(minutes = 6) {
      now += minutes * MINUTE;
      await runWatcherPass(ports);
    },
    now: () => now,
  };
}

async function invoiceNow(invoiceId: string) {
  return await db.collection("invoices").findOne({ invoice_id: invoiceId });
}

type Transfer = { kind: string; to: string; amount: string; status: string; payout?: number };
const transfers = (invoice: Record<string, unknown> | null, payout?: number) =>
  ((invoice?.transfers as Transfer[] | undefined) ?? [])
    .filter((t) => t.payout === payout)
    .map((t) => [t.kind, t.to, t.amount, t.status]);

// F1 on 100,000 sat at 5% with a 1,000 cost: 5,000 to the platform, 94,000 into the swap.
const FEE = 5_000n;
const INTO_SWAP = PAID - FEE - COST;

describe("a swap-mode invoice paid in BTC, received in USDC", () => {
  it("quotes EXACT_INPUT for what the payout sends, with the invoice's max loss, refund to the deposit, the merchant as recipient", async () => {
    const t = setUp();
    const userId = await merchant();
    const { invoiceId, address, payment } = await confirmedSwapInvoice(userId);
    t.chain.paid(address, payment);

    await t.pass();

    assert.deepEqual(t.swap.quotes, [
      { from: "btc", to: "usdceth", amountIn: INTO_SWAP, recipient: MERCHANT_USDC, refundTo: address, maxLossBps: 250 },
    ]);
    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "processing");
    assert.deepEqual(transfers(invoice), [
      ["swap_deposit", "swap-deposit-1", INTO_SWAP.toString(), "pending"],
      ["platform_fee", PLATFORM, FEE.toString(), "pending"],
    ]);
    assert.equal(invoice?.platform_fee, FEE.toString());
    assert.equal(invoice?.network_fee, COST.toString());
    assert.equal(invoice?.swap?.provider, "near_intents");
    assert.equal(invoice?.swap?.deposit_address, "swap-deposit-1");
    assert.equal(invoice?.swap?.amount_in, INTO_SWAP.toString());
    assert.equal(invoice?.swap?.status, "PENDING_DEPOSIT");
    assert.deepEqual(t.chain.broadcastsFrom(address), [{ depositAddress: address, to: "swap-deposit-1", amount: INTO_SWAP }]);
  });

  it("uses the merchant's current max loss for an invoice that has none of its own", async () => {
    const t = setUp();
    const { address, payment } = await confirmedSwapInvoice(await merchant(), { swap_max_loss_bps: null });
    t.chain.paid(address, payment);

    await t.pass();

    assert.equal(t.swap.quotes[0]?.maxLossBps, 300);
  });

  it("completes once the provider reports success and the delivery is seen at the merchant's address, recording what arrived", async () => {
    const t = setUp();
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchant());
    t.chain.paid(address, payment);
    await t.pass();
    await t.pass(); // the deposit transfer is proven
    assert.equal((await invoiceNow(invoiceId))?.status, "processing");
    assert.deepEqual(t.swap.starts, [{ provider: "near_intents", depositAddress: "swap-deposit-1", txid: "btc-tx-1" }], "told the provider the deposit was sent");

    t.swap.setStatus("swap-deposit-1", { status: "SUCCESS", amountOut: 650_000n, deliveryTxids: ["0xABCDEF01"] });
    t.chain.deliver(MERCHANT_USDC, "0xabcdef01", 649_990n);
    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.received_amount, "649990", "the amount the chain shows, not the provider's figure");
    assert.equal(invoice?.swap?.amount_delivered, "649990");
    assert.equal(invoice?.swap?.status, "SUCCESS");
    assert.deepEqual(invoice?.swap?.destination_txids, ["0xabcdef01"]);
    assert.equal(invoice?.watch_until, t.now() + 7 * 24 * 60 * MINUTE);
    assert.deepEqual(transfers(invoice), [
      ["swap_deposit", "swap-deposit-1", INTO_SWAP.toString(), "confirmed"],
      ["platform_fee", PLATFORM, FEE.toString(), "confirmed"],
    ]);
  });

  it("is not completed while the provider says success but the delivery is not on the receive chain", async () => {
    const t = setUp();
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchant());
    t.chain.paid(address, payment);
    await t.pass();
    await t.pass();

    t.swap.setStatus("swap-deposit-1", { status: "SUCCESS", amountOut: 650_000n, deliveryTxids: ["0xfeed"] });
    t.chain.deliver(MERCHANT_USDC, "0xother", 650_000n); // someone else's payment to the merchant
    await t.pass();
    let invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "processing");
    assert.equal(invoice?.swap?.status, "SUCCESS");
    assert.equal(invoice?.received_amount, "0");

    t.chain.deliver(MERCHANT_USDC, "0xfeed", 650_000n, 0);
    await t.pass();
    assert.equal((await invoiceNow(invoiceId))?.status, "processing", "the delivery has no confirmation yet");

    t.chain.deliver(MERCHANT_USDC, "0xfeed", 650_000n, 1);
    await t.pass();
    invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.swap?.amount_delivered, "650000");
  });

  it("follows the provider through its statuses, counting each change once", async () => {
    const t = setUp();
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchant());
    t.chain.paid(address, payment);
    await t.pass();
    await t.pass();
    t.swap.setStatus("swap-deposit-1", { status: "PROCESSING" });
    await t.pass();
    await t.pass();
    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.swap?.status, "PROCESSING");
    assert.equal(invoice?.swap?.version, 2, "PENDING_DEPOSIT, then PROCESSING");
  });

  it("re-quotes when the payout would send another amount than the estimate, and sends only the matching one", async () => {
    const t = setUp({ cost: 1_200n, estimate: 1_000n });
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchant());
    t.chain.paid(address, payment);

    await t.pass();

    assert.deepEqual(t.swap.quotes.map((q) => q.amountIn), [94_000n, 93_800n]);
    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.swap?.deposit_address, "swap-deposit-2");
    assert.equal(invoice?.swap?.amount_in, "93800");
    assert.deepEqual(t.chain.broadcastsFrom(address), [{ depositAddress: address, to: "swap-deposit-2", amount: 93_800n }]);
  });

  it("leaves the money at the deposit as too small to forward when it is below the swap's minimum", async () => {
    const t = setUp({}, () => ({ kind: "too_small", minimumIn: 200_000n, reason: "Amount is too low for bridge, try at least 200000" }));
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchant());
    t.chain.paid(address, payment);

    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "confirmed");
    assert.equal(invoice?.outcome, "too_small_to_forward");
    assert.deepEqual(invoice?.transfers ?? [], []);
    assert.deepEqual(t.chain.broadcastsFrom(address), []);
  });

  it("asks for no quote when fees and network cost already take it all", async () => {
    const t = setUp({ cost: 96_000n });
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchant());
    t.chain.paid(address, payment);

    await t.pass();

    assert.equal((await invoiceNow(invoiceId))?.outcome, "too_small_to_forward");
    assert.deepEqual(t.swap.quotes, []);
  });

  it("after a crash right after the swap deposit was saved, sends that saved transfer once and asks for no new quote", async () => {
    const t = setUp();
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchant());
    t.chain.paid(address, payment);
    t.chain.crashAfterNextSave();

    await t.pass();
    assert.equal((await invoiceNow(invoiceId))?.status, "processing");
    assert.deepEqual(t.chain.broadcastsFrom(address), [], "crashed before sending");

    await t.pass();
    await t.pass();
    await t.pass();

    assert.equal(t.swap.quotes.length, 1);
    assert.deepEqual(t.chain.broadcastsFrom(address), [{ depositAddress: address, to: "swap-deposit-1", amount: INTO_SWAP }]);
    assert.deepEqual(transfers(await invoiceNow(invoiceId)), [
      ["swap_deposit", "swap-deposit-1", INTO_SWAP.toString(), "confirmed"],
      ["platform_fee", PLATFORM, FEE.toString(), "confirmed"],
    ]);
  });

  it("pays a payment in the receive coin itself straight to the merchant, with no swap", async () => {
    const t = setUp();
    const userId = await merchant();
    const { invoiceId, address } = await confirmedSwapInvoice(userId, {
      crypto: "usdceth",
      payments: [],
    });
    let request: PayoutRequest | undefined;
    t.chain.chains.usdceth.payout = async (r) => {
      request = r;
      return { status: "pending", reason: "fake" };
    };

    await t.pass();

    assert.equal(request?.destination, MERCHANT_USDC);
    assert.equal(request?.destinationKind, "merchant_payout");
    assert.equal(request?.depositAddress, address);
    assert.deepEqual(t.swap.quotes, []);
    assert.equal((await invoiceNow(invoiceId))?.swap?.deposit_address ?? "", "");
  });
});

describe("a refunded swap", () => {
  /** A swap invoice whose deposit reached the provider, which then refunds `refunded` to the deposit. */
  async function refundedSwap(t: ReturnType<typeof setUp>, userId: string, refunded = 92_000n) {
    const { invoiceId, address, payment } = await confirmedSwapInvoice(userId);
    t.chain.paid(address, payment);
    await t.pass();
    await t.pass();
    t.swap.setStatus("swap-deposit-1", { status: "REFUNDED", refundedAmount: refunded, refundReason: "slippage" });
    await t.pass();
    t.chain.pay(address, "provider-refund-1", refunded);
    return { invoiceId, address };
  }

  it("fails the invoice but watches its deposit for 7 days, recording the refund", async () => {
    const t = setUp();
    const { invoiceId } = await refundedSwap(t, await merchant({ refund: { btc: REFUND_BTC } }));

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.equal(invoice?.swap?.status, "REFUNDED");
    assert.equal(invoice?.swap?.amount_refunded, "92000");
    assert.equal(invoice?.watch_until, t.now() + 7 * 24 * 60 * MINUTE);
    assert.match(invoice?.review_reason ?? "", /Refund routing forwards it/);
  });

  it("sends the refunded BTC to the merchant's BTC refund address, F1 fees taken, and never re-routes the original payment", async () => {
    const t = setUp();
    const { invoiceId, address } = await refundedSwap(t, await merchant({ refund: { btc: REFUND_BTC } }));

    await t.pass();
    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    // 92,000 − ceil(92,000 × 5%) − 1,000 = 86,400
    assert.deepEqual(transfers(invoice, 1), [
      ["refund_route", REFUND_BTC, "86400", "confirmed"],
      ["platform_fee", PLATFORM, "4600", "confirmed"],
    ]);
    assert.equal(invoice?.refund_routes?.[0]?.source, "refund_address");
    assert.equal(invoice?.refund_routes?.[0]?.state, "paid");
    assert.deepEqual(
      Object.fromEntries((invoice?.payments as { txid: string; payout?: number }[]).map((p) => [p.txid, p.payout])),
      { [`pay-${invoiceId}`]: 0, "provider-refund-1": 1 },
    );
    assert.equal(t.chain.broadcastsFrom(address).length, 2, "the swap deposit and one refund route");
    assert.equal(t.swap.quotes.length, 1);
  });

  it("with no BTC refund or payout address, swaps it to the receive coin, and records that swap's delivery", async () => {
    const t = setUp();
    const { invoiceId, address } = await refundedSwap(t, await merchant());

    await t.pass();
    let invoice = await invoiceNow(invoiceId);
    assert.deepEqual(t.swap.quotes[1], {
      from: "btc",
      to: "usdceth",
      amountIn: 86_400n,
      recipient: MERCHANT_USDC,
      refundTo: address,
      maxLossBps: 250,
    });
    const route = invoice?.refund_routes?.[0];
    assert.equal(route?.source, "swap_to_receive_coin");
    assert.equal(route?.destination, "swap-deposit-2");
    assert.equal(route?.swap?.deposit_address, "swap-deposit-2");
    assert.equal(route?.swap?.amount_in, "86400");

    await t.pass(); // the route's deposit transfer is proven
    invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.refund_routes?.[0]?.state, "swapping");
    assert.deepEqual(transfers(invoice, 1), [
      ["swap_deposit", "swap-deposit-2", "86400", "confirmed"],
      ["platform_fee", PLATFORM, "4600", "confirmed"],
    ]);

    t.swap.setStatus("swap-deposit-2", { status: "SUCCESS", deliveryTxids: ["0x0bad"] });
    t.chain.deliver(MERCHANT_USDC, "0x0bad", 590_000n);
    await t.pass();

    invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.refund_routes?.[0]?.state, "paid");
    assert.equal(invoice?.refund_routes?.[0]?.swap?.status, "SUCCESS");
    assert.equal(invoice?.refund_routes?.[0]?.swap?.amount_delivered, "590000");
    assert.equal(invoice?.status, "failed");
    assert.equal(invoice?.outcome ?? "", "", "nothing held");
  });

  it("holds the money when the fallback swap is refunded too, and never swaps it again", async () => {
    const t = setUp();
    const { invoiceId, address } = await refundedSwap(t, await merchant());
    await t.pass();
    await t.pass();
    t.swap.setStatus("swap-deposit-2", { status: "REFUNDED", refundedAmount: 85_000n });
    await t.pass();
    assert.equal((await invoiceNow(invoiceId))?.refund_routes?.[0]?.state, "refunded");

    t.chain.pay(address, "provider-refund-2", 85_000n);
    await t.pass();
    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.outcome, "held_for_manual_handling");
    assert.match(invoice?.review_reason ?? "", /Held for manual handling: 85000 .* from payment\(s\) provider-refund-2 is at deposit address/);
    assert.equal(t.swap.quotes.length, 2, "no third swap");
    assert.equal(invoice?.refund_routes?.length, 1);
  });

  it("forwards held money once the merchant sets a BTC refund address, without swapping", async () => {
    const t = setUp();
    const userId = await merchant();
    const { invoiceId, address } = await refundedSwap(t, userId);
    await t.pass();
    await t.pass();
    t.swap.setStatus("swap-deposit-2", { status: "REFUNDED", refundedAmount: 85_000n });
    await t.pass();
    t.chain.pay(address, "provider-refund-2", 85_000n);
    await t.pass();
    await db.collection("users").updateOne({ user_id: userId }, { $set: { "refund_addresses.btc": REFUND_BTC } });

    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.refund_routes?.[1]?.source, "refund_address");
    assert.equal(t.swap.quotes.length, 2);
  });
});

describe("a swap saved before ticket 15 (BTC deposit, USDC payout, fixed mode)", () => {
  it("is followed by the new code and completes when the delivery is seen", async () => {
    const t = setUp();
    const userId = await merchant();
    const { invoiceId, address } = await confirmedSwapInvoice(userId, {
      mode: "fixed",
      status: "processing",
      swap_max_loss_bps: null,
      transfers: [
        { kind: "swap_deposit", to: "legacy-near-deposit", amount: "94000", txid: "legacy-tx", status: "confirmed" },
        { kind: "platform_fee", to: PLATFORM, amount: "5000", txid: "legacy-tx", status: "confirmed" },
      ],
      platform_fee: "5000",
      network_fee: "1000",
      tx: { in: "", out: "legacy-tx", raw: "legacy-hex", platform_out: "legacy-tx" },
      swap: {
        deposit_address: "legacy-near-deposit",
        status: "PENDING_DEPOSIT",
        deadline: "2026-11-19T12:00:00.000Z",
        quote_response: { quoteRequest: { refundTo: "the-old-refund-to" }, quote: { minAmountOut: "600000" } },
      },
      timestamps: { created: NOW - 60 * MINUTE, waiting: NOW - 60 * MINUTE, processing: NOW - 30 * MINUTE },
    });
    t.swap.setStatus("legacy-near-deposit", { status: "SUCCESS", deliveryTxids: ["0x1e9ac7"] });
    t.chain.deliver(MERCHANT_USDC, "0x1e9ac7", 640_000n);

    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.swap?.amount_delivered, "640000");
    assert.deepEqual(t.chain.broadcastsFrom(address), []);
    assert.deepEqual(t.swap.quotes, []);
  });

  it("says where a refund went when it was not the deposit address", async () => {
    const t = setUp();
    const { invoiceId } = await confirmedSwapInvoice(await merchant(), {
      mode: "fixed",
      status: "processing",
      transfers: [{ kind: "swap_deposit", to: "legacy-near-2", amount: "94000", txid: "legacy-tx-2", status: "confirmed" }],
      swap: { deposit_address: "legacy-near-2", status: "PROCESSING", quote_response: { quoteRequest: { refundTo: "UQplatform" } } },
      timestamps: { processing: NOW - 30 * MINUTE },
    });
    t.swap.setStatus("legacy-near-2", { status: "REFUNDED", refundedAmount: 93_000n });

    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.match(invoice?.review_reason ?? "", /back to UQplatform, not to the deposit address/);
  });
});

describe("swap status changes in the merchant's webhook outbox", () => {
  async function merchantWithWebhook() {
    const userId = await merchant();
    await db.collection("users").updateOne(
      { user_id: userId },
      { $set: { webhook_url: "https://shop.example/hook", webhook_secret: sealSecret("webhook-secret", "whsec_swap_test") } },
    );
    return userId;
  }

  const posted: string[] = [];
  const webhookPass = async (now: number) =>
    await runWebhookPass({
      now: () => now,
      isAllowedDestination: async () => true,
      post: async (_url, init) => {
        posted.push(String(init?.body));
        return new Response(null, { status: 200 });
      },
    });

  async function outbox(invoiceId: string) {
    const events = await db.collection("webhook_events").find({ invoiceId }).sort({ _id: 1 }).toArray();
    return events.map((e) => ({ eventId: e.eventId as string, body: JSON.parse(e.payload as string) }));
  }

  it("announces the swap, its refund, the fallback swap and its delivery once each, under unique ids", async () => {
    const t = setUp();
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchantWithWebhook());
    t.chain.paid(address, payment);
    const step = async () => {
      await t.pass();
      await webhookPass(t.now());
    };

    await step(); // quoted, paid into the swap
    await step(); // the deposit transfer is proven
    t.swap.setStatus("swap-deposit-1", { status: "REFUNDED", refundedAmount: 92_000n, refundReason: "slippage" });
    await step();
    t.chain.pay(address, "provider-refund-1", 92_000n);
    await step(); // no BTC refund or payout address: the fallback swap is quoted
    await step(); // its deposit transfer is proven
    t.swap.setStatus("swap-deposit-2", { status: "SUCCESS", deliveryTxids: ["0x0bad"] });
    t.chain.deliver(MERCHANT_USDC, "0x0bad", 590_000n);
    await step();
    await step(); // nothing new

    const events = await outbox(invoiceId);
    const ids = events.map((e) => e.eventId);
    assert.equal(new Set(ids).size, ids.length, "every event id is unique");
    for (const id of [
      swapEventId(invoiceId, 1),
      swapEventId(invoiceId, 2),
      refundRouteSwapEventId(invoiceId, 1, 1),
      refundRouteSwapEventId(invoiceId, 1, 2),
      refundRouteEventId(invoiceId, 1),
    ]) {
      assert.ok(ids.includes(id), `missing ${id} in ${ids.join(", ")}`);
    }
    assert.equal(ids.filter((id) => id.includes(":swap:")).length, 4, "no swap change announced twice");
    assert.deepEqual(
      events.filter((e) => e.body.event === "invoice.status_changed").map((e) => e.body.status),
      ["confirmed", "processing", "failed"],
      "each status change once, in order",
    );

    const byId = (id: string) => events.find((e) => e.eventId === id)!.body;
    assert.equal(byId(swapEventId(invoiceId, 1)).swap.amountIn, INTO_SWAP.toString());
    assert.equal(byId(swapEventId(invoiceId, 2)).swap.status, "REFUNDED");
    assert.equal(byId(swapEventId(invoiceId, 2)).swap.amountRefunded, "92000");
    assert.equal(byId(refundRouteSwapEventId(invoiceId, 1, 1)).refundRoute.swap.amountIn, "86400");
    assert.equal(byId(refundRouteSwapEventId(invoiceId, 1, 2)).refundRoute.swap.amountDelivered, "590000");
    assert.equal(byId(refundRouteEventId(invoiceId, 1)).refundRoute.amount, "86400");
    assert.equal(
      posted.filter((body) => JSON.parse(body).invoiceId === invoiceId).length,
      events.length,
      "each event was posted once",
    );
  });

  it("announces a swap's delivered amount when it completes", async () => {
    const t = setUp();
    const { invoiceId, address, payment } = await confirmedSwapInvoice(await merchantWithWebhook());
    t.chain.paid(address, payment);
    await t.pass();
    await t.pass();
    t.swap.setStatus("swap-deposit-1", { status: "SUCCESS", deliveryTxids: ["0xfeed"] });
    t.chain.deliver(MERCHANT_USDC, "0xfeed", 650_000n);
    await t.pass();

    await webhookPass(t.now());

    const events = await outbox(invoiceId);
    const statuses = events.filter((e) => e.body.event === "invoice.status_changed");
    assert.deepEqual(statuses.map((e) => e.body.status), ["confirmed", "processing", "completed"]);
    const completed = statuses.at(-1)?.body;
    assert.equal(completed?.swap.amountDelivered, "650000");
    assert.equal(completed?.merchantAmount, "650000");
    const changed = events.find((e) => e.eventId === swapEventId(invoiceId, 2))?.body;
    assert.equal(changed?.swap.status, "SUCCESS");
    assert.equal(changed?.swap.amountDelivered, "650000");
  });
});
