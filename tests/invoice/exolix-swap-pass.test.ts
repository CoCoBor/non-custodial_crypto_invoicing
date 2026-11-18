import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Db } from "mongodb";

import type { AssetId } from "../../src/assets/payout-address.js";
import type { ChainAdapter, ChainPayment, PayoutRequest, PayoutResult } from "../../src/chains/adapter.js";
import { connectToMongoDb, disconnectFromMongoDB } from "../../src/infrastructure/database/mongodb.js";
import { runWatcherPass, type WatcherPorts } from "../../src/invoice/invoice.watcher.js";
import { splitPayout } from "../../src/money/payout-split.js";
import { createSwapProvider } from "../../src/swap/registry.js";

// Swap mode with XMR on either side, in a watcher pass. The swap port is the
// real one (router, Exolix and NEAR adapters); only their HTTP is faked, with
// the Exolix replies in tests/fixtures/exolix/. The chains are faked at their
// adapters: like the real xmr adapter, the XMR one sees only addresses of the
// platform wallet (the invoice's subaddress), never a merchant's.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test.

const NOW = Date.parse("2026-11-18T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const XMR_INVOICE = "86kKnBKFqzCLxtK1Jmx2BkNBDBSMDEVaRYMMyVbeURYDWs8uNGDZURKCA5yRcyMxHzPcmCf1q2fSdhQVcaKsFrtGRsdGfNk";
const XMR_EXOLIX = "8AsN91rznfkBGTY8psSNkJBg9SZgxxGGRUhGwRptBhgr5XSQ1XzmA9m8QAnoxydecSh5aLJXdrgXwTDMMZ1AuXsN1EX5Mtm";
const XMR_MERCHANT = "44Kbx4sJ7JDRDV5aAhLJzQCjDz2ViLRduE3ijDZu3osWKBjMGkV1XPk4pfDUMqt1Aiezvephdqm6YD19GKFD9ZcXVUTp6BW";
const XMR_MERCHANT_REFUND = "42ey1afDFnn4886T7196doS9GPMzexD9gXpsZJDwVjeRVdFCSoHnv7KPbBeGpzJBzHRCAs9UxqeoyFQMYbqSWYTfJJQAWDm";
const TRON_MERCHANT = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const BTC_INVOICE = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const BTC_EXOLIX = "bc1q9d4ywgfnd8h43da5tpcxcn6ajv590cg6d3tg6axemvljvt2k76zs50tv4q";
const USDC_MERCHANT = "0x000000000000000000000000000000000000dEaD";
const SWAP_ID = "exo0a1b2c3d4e5f";
const DELIVERY = "a7b9c3d1e5f70819a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70819";

const COST: Partial<Record<AssetId, bigint>> = { xmr: 1_000_000_000n, btc: 1_000n };
const PLATFORM: Partial<Record<AssetId, string>> = { xmr: "platform-xmr", btc: "platform-btc" };

// F1 at 5% on 1.58 XMR with a 0.001 XMR cost: 0.079 XMR to the platform,
// exactly 1.5 XMR into the swap (the amount in the recorded rate).
const XMR_PAID = 1_580_000_000_000n;
const XMR_FEE = 79_000_000_000n;
const XMR_INTO_SWAP = 1_500_000_000_000n;
// And 100,000 sat with a 1,000 sat cost: 94,000 sat into the swap.
const BTC_PAID = 100_000n;
const BTC_INTO_SWAP = 94_000n;

let db: Db;
const invoiceIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  db = await connectToMongoDb();
});

beforeEach(async () => {
  await db.collection("invoices").deleteMany({ invoice_id: { $in: invoiceIds } });
});

after(async () => {
  await db.collection("invoices").deleteMany({ invoice_id: { $in: invoiceIds } });
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await disconnectFromMongoDB();
});

const raw = (path: string): string => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");

/** Exolix (and NEAR) over a faked fetch. Transactions are answered from `transactions`, by id. */
function fakeProviders() {
  const calls: { method: string; url: string }[] = [];
  const transactions = new Map<string, string>();
  const nearStatuses = new Map<string, string>();
  const replies = { rate: raw("exolix/rate-xmr-usdttrx-float.json"), create: raw("exolix/create-built-xmr-usdttrx.json") };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const json = (text: string | undefined, status = 200) => new Response(text ?? JSON.stringify({ message: "Not found" }), { status: text === undefined ? 404 : status });
    if (url.startsWith("https://1click.chaindefuser.com/v0/status")) return json(nearStatuses.get(new URL(url).searchParams.get("depositAddress") ?? ""));
    if (url.startsWith("https://1click.chaindefuser.com/")) return json("{}");
    if (url.startsWith("https://exolix.com/api/v2/rate?")) return json(replies.rate);
    if (url === "https://exolix.com/api/v2/transactions" && method === "POST") return json(replies.create);
    if (url.startsWith("https://exolix.com/api/v2/transactions/")) return json(transactions.get(url.split("/").pop()!));
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    replies,
    exolixCalls: () => calls.filter((c) => c.url.startsWith("https://exolix.com/")).map((c) => `${c.method} ${new URL(c.url).pathname}`),
    nearCalls: () => calls.filter((c) => c.url.startsWith("https://1click.chaindefuser.com/")),
    /** Exolix's transaction now: its create reply with another status, and a delivery once it sends. */
    setTransaction(text: string) {
      transactions.set(SWAP_ID, text);
      transactions.set("exo9f8e7d6c5b4a", text);
    },
    setNearStatus(depositAddress: string, text: string) {
      nearStatuses.set(depositAddress, text);
    },
  };
}

const withStatus = (text: string, status: string, hashOut?: string) => {
  let out = text.replace('"status": "wait"', `"status": "${status}"`);
  if (hashOut) out = out.replace(/"hashOut": \{\s*"hash": null/, `"hashOut": {\n    "hash": "${hashOut}"`);
  return out;
};

/**
 * Chains that sweep every confirmed, unspent payment at a deposit with F1
 * and the asset's network cost, save before sending, and send a saved
 * payout once. getPayments of an XMR address outside the platform wallet is
 * undefined, as the real adapter answers.
 */
function fakeChains() {
  const ledger = new Map<string, ChainPayment[]>();
  const spent = new Set<string>();
  const sent = new Set<string>();
  const broadcasts: { asset: AssetId; from: string; to: string; amount: bigint }[] = [];
  const wallet = new Set([XMR_INVOICE]);
  let counter = 0;

  function chain(asset: AssetId, isValidAddress: (address: string) => boolean): ChainAdapter {
    const cost = COST[asset] ?? 0n;
    const send = (request: PayoutRequest, state: string, transfers: { to: string; amount: bigint }[]) => {
      sent.add(state);
      for (const p of ledger.get(request.depositAddress) ?? []) if (p.confirmations >= 1) spent.add(`${request.depositAddress}:${p.txid}`);
      broadcasts.push({ asset, from: request.depositAddress, to: transfers[0]!.to, amount: transfers[0]!.amount });
    };
    return {
      asset,
      requiredConfirmations: 1,
      isValidAddress,
      canPayOutAs: (receive) => receive === asset,
      newDeposit: async () => {
        throw new Error("not used");
      },
      getPayments: async (address) => (asset === "xmr" && !wallet.has(address) ? undefined : [...(ledger.get(address) ?? [])]),
      estimateNetworkCost: async () => cost,
      async payout(request): Promise<PayoutResult> {
        if (request.checkpoint) {
          if (!sent.has(request.checkpoint.state)) {
            send(request, request.checkpoint.state, request.checkpoint.plan.transfers);
            return { status: "pending", reason: "sent the saved payout" };
          }
          return { status: "paid", transfers: request.checkpoint.plan.transfers };
        }
        const unspent = (ledger.get(request.depositAddress) ?? []).filter((p) => p.confirmations >= 1 && !spent.has(`${request.depositAddress}:${p.txid}`));
        const total = unspent.reduce((sum, p) => sum + p.amount, 0n);
        if (total <= 0n || total < request.minimumAmount) return { status: "pending", reason: "deposit below the minimum" };
        const split = splitPayout({ received: total, networkCost: cost, feeRate: request.feeRate, feeExempt: request.feeExempt ?? 0n });
        if (split === undefined) return { status: "too_small", reason: "fake: too small" };
        counter += 1;
        const txid = `${asset}-tx-${counter}`;
        const plan = {
          transfers: [
            { kind: request.destinationKind, to: request.destination, amount: split.merchantAmount, txid },
            // Like the real adapters: no platform transfer when no fee is due.
            ...(split.platformFee > 0n ? [{ kind: "platform_fee" as const, to: PLATFORM[asset]!, amount: split.platformFee, txid }] : []),
          ],
          platformFee: split.platformFee,
          networkCost: cost,
        };
        const state = `signed-${txid}`;
        if (!(await request.saveCheckpoint({ state, plan }))) return { status: "pending", reason: "not saved" };
        send(request, state, plan.transfers);
        return { status: "pending", reason: "broadcast" };
      },
    };
  }

  return {
    chains: {
      xmr: chain("xmr", (a) => /^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(a)),
      btc: chain("btc", (a) => a.startsWith("bc1")),
      usdttrx: chain("usdttrx", (a) => a.startsWith("T")),
      usdceth: chain("usdceth", (a) => a.startsWith("0x")),
    },
    broadcasts,
    /** A confirmed payment to `address` (a payer, a refund, or a provider's delivery). */
    pay(address: string, txid: string, amount: bigint, confirmations = 1) {
      const others = (ledger.get(address) ?? []).filter((p) => p.txid !== txid);
      ledger.set(address, [...others, { txid, amount, confirmations, seenAt: NOW }]);
    },
  };
}

function setUp(prices: Partial<Record<AssetId, string>> = { xmr: "502", usdttrx: "1", btc: "63000" }) {
  let now = NOW;
  const chain = fakeChains();
  const http = fakeProviders();
  const swap = createSwapProvider({ fetch: http.fetch, nearJwt: "", exolixApiKey: "test-exolix-key", now: () => now, usdPrice: async (asset) => prices[asset] });
  const ports: WatcherPorts = { now: () => now, chains: chain.chains as unknown as WatcherPorts["chains"], swap };
  return {
    chain,
    http,
    async pass(minutes = 6) {
      now += minutes * MINUTE;
      await runWatcherPass(ports);
    },
    now: () => now,
  };
}

async function merchant(fields: { payout?: Record<string, string>; refund?: Record<string, string> }) {
  const userId = randomUUID();
  userIds.push(userId);
  await db.collection("users").insertOne({
    user_id: userId,
    merchant_fee: "0.05",
    swap_max_loss_bps: 50,
    payout_addresses: fields.payout ?? {},
    refund_addresses: fields.refund ?? {},
  });
  return userId;
}

/** A confirmed swap-mode invoice: the next pass pays it into a swap. */
async function confirmedSwapInvoice(userId: string, fields: { crypto: AssetId; to_crypto: AssetId; to_address: string; address: string; paid: bigint } & Record<string, unknown>) {
  const invoiceId = randomUUID();
  invoiceIds.push(invoiceId);
  const { paid, ...rest } = fields;
  await db.collection("invoices").insertOne({
    invoice_id: invoiceId,
    user_id: userId,
    status: "confirmed",
    mode: "swap",
    offered_coins: [fields.crypto, fields.to_crypto],
    amount: paid.toString(),
    asked_amount: paid.toString(),
    amount_fiat: "79000",
    paid_amount: paid.toString(),
    lifetime: 30,
    fee_rate: "0.05",
    swap_max_loss_bps: 50,
    payments: [{ txid: `pay-${invoiceId}`, amount: paid.toString(), first_seen_at: NOW - 10 * MINUTE, confirmations: 1, on_time: true }],
    timestamps: { created: NOW - 20 * MINUTE, waiting: NOW - 20 * MINUTE, confirmed: NOW - MINUTE },
    ...(fields.crypto === "xmr"
      ? { subaddress_index: 7 }
      : { private: { private_key: { keyVersion: 1, initialisationVector: randomBytes(12), authenticationTag: randomBytes(16), ciphertext: randomBytes(32) } } }),
    ...rest,
  });
  return invoiceId;
}

async function xmrToUsdtInvoice(t: ReturnType<typeof setUp>, refund: Record<string, string> = {}) {
  const userId = await merchant({ payout: { usdttrx: TRON_MERCHANT }, refund });
  const invoiceId = await confirmedSwapInvoice(userId, { crypto: "xmr", to_crypto: "usdttrx", to_address: TRON_MERCHANT, address: XMR_INVOICE, paid: XMR_PAID });
  t.chain.pay(XMR_INVOICE, `pay-${invoiceId}`, XMR_PAID);
  return invoiceId;
}

const invoiceNow = async (invoiceId: string) => await db.collection("invoices").findOne({ invoice_id: invoiceId });

type Transfer = { kind: string; to: string; amount: string; status: string; payout?: number };
const transfersOf = (invoice: Record<string, unknown> | null, payout?: number) =>
  ((invoice?.transfers as Transfer[] | undefined) ?? []).filter((t) => t.payout === payout).map((t) => [t.kind, t.to, t.amount, t.status]);

describe("XMR paid, swapped by Exolix into USDT on Tron", () => {
  it("takes the platform fee in XMR and pays the rest into an Exolix float swap, refunding to the invoice's subaddress", async () => {
    const t = setUp();
    const invoiceId = await xmrToUsdtInvoice(t);

    await t.pass();

    assert.deepEqual(t.http.exolixCalls(), ["GET /api/v2/rate", "POST /api/v2/transactions"]);
    assert.deepEqual(t.http.nearCalls(), [], "NEAR is never asked about an XMR pair");
    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "processing");
    assert.deepEqual(transfersOf(invoice), [
      ["swap_deposit", XMR_EXOLIX, XMR_INTO_SWAP.toString(), "pending"],
      ["platform_fee", "platform-xmr", XMR_FEE.toString(), "pending"],
    ]);
    assert.deepEqual(t.chain.broadcasts, [{ asset: "xmr", from: XMR_INVOICE, to: XMR_EXOLIX, amount: XMR_INTO_SWAP }]);
    assert.equal(invoice?.swap?.provider, "exolix");
    assert.equal(invoice?.swap?.provider_swap_id, SWAP_ID);
    assert.equal(invoice?.swap?.deposit_address, XMR_EXOLIX);
    assert.equal(invoice?.swap?.amount_in, XMR_INTO_SWAP.toString());
    assert.equal(invoice?.swap?.min_amount_out, "749235000", "753 USDT at our price, less 50 bps");
    assert.equal(invoice?.swap?.deadline, "");
    assert.equal(invoice?.swap?.status, "PENDING_DEPOSIT");
  });

  it("follows Exolix by its transaction id, and completes only once the delivery is seen at the merchant's address", async () => {
    const t = setUp();
    const invoiceId = await xmrToUsdtInvoice(t);
    t.http.setTransaction(t.http.replies.create);
    await t.pass();
    await t.pass(); // the deposit transfer is proven

    let invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "processing");
    assert.deepEqual(transfersOf(invoice).map((row) => row[3]), ["confirmed", "confirmed"]);
    assert.ok(t.http.exolixCalls().includes(`GET /api/v2/transactions/${SWAP_ID}`));

    t.http.setTransaction(raw("exolix/transaction-built-xmr-usdttrx-success.json"));
    await t.pass();
    invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "processing", "Exolix says success, but Tron shows nothing yet");
    assert.equal(invoice?.swap?.status, "SUCCESS");

    t.chain.pay(TRON_MERCHANT, DELIVERY, 751_902_300n);
    await t.pass();
    invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.received_amount, "751902300");
    assert.equal(invoice?.swap?.amount_delivered, "751902300");
    assert.deepEqual(invoice?.swap?.destination_txids, [DELIVERY]);
    assert.equal(invoice?.swap?.version, 2, "saved, then SUCCESS: two webhook events");
    assert.deepEqual(t.http.nearCalls(), []);
  });

  it("sends nothing when Exolix's rate loses more than the merchant's max loss against our own price", async () => {
    const t = setUp({ xmr: "510", usdttrx: "1" }); // 1.5 XMR = 765 USDT; Exolix gives 752.17 (168 bps less)
    const invoiceId = await xmrToUsdtInvoice(t);

    await t.pass();

    assert.deepEqual(t.http.exolixCalls(), ["GET /api/v2/rate"], "no transaction opened");
    assert.deepEqual(t.chain.broadcasts, []);
    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "confirmed", "asked again later");
    assert.equal(invoice?.swap?.deposit_address ?? "", "");
  });

  it("when Exolix refunds, fails the invoice with the 7-day watch and forwards the refunded XMR to the merchant's refund address with no second fee", async () => {
    const t = setUp();
    const invoiceId = await xmrToUsdtInvoice(t, { xmr: XMR_MERCHANT_REFUND });
    t.http.setTransaction(t.http.replies.create);
    await t.pass();
    await t.pass();

    t.http.setTransaction(raw("exolix/transaction-built-xmr-usdttrx-refunded.json"));
    await t.pass();
    let invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "failed");
    assert.equal(invoice?.swap?.status, "REFUNDED");
    assert.match(invoice?.swap?.refund_reason ?? "", /slippage limit/);
    assert.equal(invoice?.watch_until, t.now() + 7 * 24 * HOUR);

    // The refund lands at the invoice's subaddress: routing forwards it.
    t.chain.pay(XMR_INVOICE, "exolix-refund", 1_499_000_000_000n);
    await t.pass();
    await t.pass();
    await t.pass();

    // 1.499 XMR, whose fee was taken before the swap (Exolix names no refunded
    // amount; the 1.5 XMR sent in counts): 0.001 network cost, the rest to the merchant.
    assert.deepEqual(t.chain.broadcasts.at(-1), { asset: "xmr", from: XMR_INVOICE, to: XMR_MERCHANT_REFUND, amount: 1_498_000_000_000n });
    invoice = await invoiceNow(invoiceId);
    assert.deepEqual(transfersOf(invoice, 1), [["refund_route", XMR_MERCHANT_REFUND, "1498000000000", "confirmed"]]);
  });
});

describe("BTC paid, the merchant receiving XMR through Exolix", () => {
  async function btcToXmrInvoice(t: ReturnType<typeof setUp>) {
    t.http.replies.rate = raw("exolix/rate-btc-xmr-float.json");
    t.http.replies.create = raw("exolix/create-built-btc-xmr.json");
    const userId = await merchant({ payout: { xmr: XMR_MERCHANT } });
    const invoiceId = await confirmedSwapInvoice(userId, { crypto: "btc", to_crypto: "xmr", to_address: XMR_MERCHANT, address: BTC_INVOICE, paid: BTC_PAID });
    t.chain.pay(BTC_INVOICE, `pay-${invoiceId}`, BTC_PAID);
    return invoiceId;
  }

  it("takes the platform fee in BTC and pays the rest into a swap to the merchant's XMR address, refunding to the BTC deposit", async () => {
    const t = setUp();
    const invoiceId = await btcToXmrInvoice(t);

    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "processing");
    assert.deepEqual(transfersOf(invoice), [
      ["swap_deposit", BTC_EXOLIX, BTC_INTO_SWAP.toString(), "pending"],
      ["platform_fee", "platform-btc", "5000", "pending"],
    ]);
    assert.equal(invoice?.swap?.provider, "exolix");
    assert.equal(invoice?.swap?.recipient, XMR_MERCHANT);
    assert.equal(invoice?.swap?.receive_crypto, "xmr");
  });

  it("is never completed on Exolix's word alone: Monero hides the receiver, so a person must confirm with the merchant", async () => {
    const t = setUp();
    const invoiceId = await btcToXmrInvoice(t);
    t.http.setTransaction(t.http.replies.create);
    await t.pass();
    await t.pass();

    t.http.setTransaction(withStatus(t.http.replies.create, "success", DELIVERY));
    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "processing");
    assert.equal(invoice?.swap?.status, "SUCCESS");
    assert.match(invoice?.review_reason ?? "", /Monero/);
    assert.match(invoice?.review_reason ?? "", new RegExp(DELIVERY));
    assert.match(invoice?.review_reason ?? "", new RegExp(XMR_MERCHANT));
  });
});

describe("a NEAR swap saved before ticket 24 (no provider swap id)", () => {
  it("is still followed through NEAR by its deposit address, and completes when the delivery is seen", async () => {
    const t = setUp();
    const userId = await merchant({ payout: { usdceth: USDC_MERCHANT } });
    const invoiceId = await confirmedSwapInvoice(userId, {
      crypto: "btc",
      to_crypto: "usdceth",
      to_address: USDC_MERCHANT,
      address: BTC_INVOICE,
      paid: BTC_PAID,
      status: "processing",
      transfers: [
        { kind: "swap_deposit", to: "near-deposit", amount: "94000", txid: "old-tx", status: "confirmed" },
        { kind: "platform_fee", to: "platform-btc", amount: "5000", txid: "old-tx", status: "confirmed" },
      ],
      platform_fee: "5000",
      network_fee: "1000",
      tx: { in: "", out: "old-tx", raw: "old-signed", platform_out: "old-tx" },
      swap: { provider: "near_intents", deposit_address: "near-deposit", status: "PROCESSING", version: 1, notified_version: 1 },
      timestamps: { created: NOW - 60 * MINUTE, waiting: NOW - 60 * MINUTE, processing: NOW - 30 * MINUTE },
    });
    t.http.setNearStatus("near-deposit", raw("near/status-built-success.json"));
    t.chain.pay(USDC_MERCHANT, "0x5f6e7d8c9b0a1f2e3d4c5b6a79881726354a5b6c7d8e9f0a1b2c3d4e5f607182", 64_400_000n);

    await t.pass();

    const invoice = await invoiceNow(invoiceId);
    assert.equal(invoice?.status, "completed");
    assert.equal(invoice?.received_amount, "64400000");
    assert.equal(t.http.nearCalls()[0]?.url, "https://1click.chaindefuser.com/v0/status?depositAddress=near-deposit");
    assert.deepEqual(t.http.exolixCalls(), []);
  });
});
