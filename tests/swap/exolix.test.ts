import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ASSET_IDS, type AssetId } from "../../src/assets/payout-address.js";
import cryptos from "../../src/storage/cryptos.json" with { type: "json" };
import { createExolixSwap, exolixCode } from "../../src/swap/exolix.js";
import type { SwapRequest, SwapStatusName } from "../../src/swap/swap-port.js";

// The Exolix adapter (API v2, float rate), tested by parsing replies (no
// network). Recorded 2026-11-18 with no API key and no funds:
// networks-<COIN>.json (GET /currencies/<COIN>/networks) and rate-*.json
// (GET /rate, float). Built from the examples in the API documentation
// (https://exolix.com/developers), since creating a transaction opens a real
// exchange: create-built-*.json, transaction-built-*.json, and
// transaction-docs-example.json (the documentation's own example, verbatim).
// Fixtures are served as their raw text: Exolix writes amounts as JSON
// numbers, and a test must not round them through a float either.

const raw = (name: string): string => readFileSync(new URL(`../fixtures/exolix/${name}`, import.meta.url), "utf8");
const fixture = (name: string): unknown => JSON.parse(raw(name));

const XMR_INVOICE = "86kKnBKFqzCLxtK1Jmx2BkNBDBSMDEVaRYMMyVbeURYDWs8uNGDZURKCA5yRcyMxHzPcmCf1q2fSdhQVcaKsFrtGRsdGfNk";
const XMR_EXOLIX = "8AsN91rznfkBGTY8psSNkJBg9SZgxxGGRUhGwRptBhgr5XSQ1XzmA9m8QAnoxydecSh5aLJXdrgXwTDMMZ1AuXsN1EX5Mtm";
const XMR_MERCHANT = "44Kbx4sJ7JDRDV5aAhLJzQCjDz2ViLRduE3ijDZu3osWKBjMGkV1XPk4pfDUMqt1Aiezvephdqm6YD19GKFD9ZcXVUTp6BW";
const TRON_MERCHANT = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const BTC_INVOICE = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const BTC_EXOLIX = "bc1q9d4ywgfnd8h43da5tpcxcn6ajv590cg6d3tg6axemvljvt2k76zs50tv4q";

// 1.5 XMR into USDT on Tron, as in rate-xmr-usdttrx-float.json.
const XMR_TO_USDT: SwapRequest = {
  from: "xmr",
  to: "usdttrx",
  amountIn: 1_500_000_000_000n,
  recipient: TRON_MERCHANT,
  refundTo: XMR_INVOICE,
  maxLossBps: 50,
};

// 94,000 sat into XMR, as in rate-btc-xmr-float.json.
const BTC_TO_XMR: SwapRequest = {
  from: "btc",
  to: "xmr",
  amountIn: 94_000n,
  recipient: XMR_MERCHANT,
  refundTo: BTC_INVOICE,
  maxLossBps: 50,
};

// Our own USD prices. At these, 1.5 XMR is worth 753 USDT; Exolix's rate gives
// 752.1745 (11 bps less).
const PRICES: Partial<Record<AssetId, string>> = { xmr: "502", usdttrx: "1", btc: "63000", eth: "1800" };

type Reply = { status: number; text: string };
type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

/** Answers Exolix's three endpoints from fixtures; `undefined` throws like a network failure. */
function fakeExolix(replies: { rate?: Reply; create?: Reply; transaction?: Reply }) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? String(init.body) : undefined });
    const reply = url.includes("/rate?") ? replies.rate : method === "POST" ? replies.create : replies.transaction;
    if (reply === undefined) throw new Error("connect ECONNREFUSED");
    return new Response(reply.text, { status: reply.status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (name: string): Reply => ({ status: 200, text: raw(name) });

function adapter(
  replies: Parameters<typeof fakeExolix>[0],
  options: { apiKey?: string; prices?: Partial<Record<AssetId, string>> } = {},
) {
  const fake = fakeExolix(replies);
  const prices = options.prices ?? PRICES;
  const swap = createExolixSwap({
    fetch: fake.fetch,
    apiKey: options.apiKey ?? "test-exolix-key",
    usdPrice: async (asset) => prices[asset],
  });
  return { swap, calls: fake.calls };
}

/** A reply fixture with some fields changed (only for fields whose numbers survive JSON.parse). */
function changed(name: string, fields: Record<string, unknown>, status = 200): Reply {
  return { status, text: JSON.stringify({ ...(fixture(name) as object), ...fields }) };
}

const xmrToUsdt = () => ({ rate: ok("rate-xmr-usdttrx-float.json"), create: ok("create-built-xmr-usdttrx.json") });

describe("Exolix coin codes", () => {
  type Network = { network: string; memoNeeded: boolean; contract: string | null };
  const NATIVE_CONTRACTS = [null, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "So11111111111111111111111111111111111111111"];

  for (const asset of ASSET_IDS) {
    const code = exolixCode(asset);
    if (code === undefined) continue;
    it(`${asset} is ${code.coin} on ${code.network} in Exolix's recorded list, needing no memo, with our contract`, () => {
      const networks = fixture(`networks-${code.coin}.json`) as Network[];
      const network = networks.find((n) => n.network === code.network);
      assert.ok(network, "Exolix does not list this network for the coin");
      assert.equal(network.memoNeeded, false);
      const coin = cryptos[asset] as { contract_address?: string; mint_address?: string; jetton_master?: string };
      const ours = coin.contract_address ?? coin.mint_address ?? coin.jetton_master;
      if (ours === undefined) assert.ok(NATIVE_CONTRACTS.includes(network.contract), `a native coin, not ${network.contract}`);
      else assert.equal(network.contract?.toLowerCase(), ours.toLowerCase());
    });
  }

  it("has XMR on its own network", () => {
    assert.deepEqual(exolixCode("xmr"), { coin: "XMR", network: "XMR" });
  });

  it("has no code for TON: Exolix lists only a wrapped TON on Solana", () => {
    assert.equal(exolixCode("ton"), undefined);
    const networks = fixture("networks-TON.json") as Network[];
    assert.deepEqual(networks.map((n) => n.network), ["SOL"]);
  });
});

describe("which pairs Exolix serves", () => {
  const { swap } = adapter({});

  it("serves XMR on either side, paired with any coin it has a code for", () => {
    assert.equal(swap.supports("xmr", "usdttrx"), true);
    assert.equal(swap.supports("btc", "xmr"), true);
    assert.equal(swap.supports("usdtton", "xmr"), true);
  });

  it("serves no pair without XMR (NEAR's), no pair with TON, and not XMR into XMR", () => {
    assert.equal(swap.supports("btc", "usdceth"), false);
    assert.equal(swap.supports("ton", "xmr"), false);
    assert.equal(swap.supports("xmr", "ton"), false);
    assert.equal(swap.supports("xmr", "xmr"), false);
  });

  it("serves nothing without an API key (Exolix is off)", () => {
    const off = adapter({}, { apiKey: "" }).swap;
    assert.equal(off.supports("xmr", "usdttrx"), false);
    assert.equal(off.supports("btc", "xmr"), false);
  });
});

describe("an Exolix quote (float rate)", () => {
  it("asks the float rate for the exact amount, then opens a float transaction to the merchant, refunding to the deposit", async () => {
    const { swap, calls } = adapter(xmrToUsdt());

    await swap.quote(XMR_TO_USDT);

    assert.equal(calls.length, 2);
    const rate = new URL(calls[0]!.url);
    assert.equal(rate.origin + rate.pathname, "https://exolix.com/api/v2/rate");
    assert.deepEqual(Object.fromEntries(rate.searchParams), {
      coinFrom: "XMR",
      networkFrom: "XMR",
      coinTo: "USDT",
      networkTo: "TRX",
      amount: "1.5",
      rateType: "float",
    });
    assert.equal(calls[0]!.headers["api-key"], "test-exolix-key");

    assert.equal(calls[1]!.url, "https://exolix.com/api/v2/transactions");
    assert.equal(calls[1]!.method, "POST");
    assert.equal(calls[1]!.headers["api-key"], "test-exolix-key");
    assert.equal(calls[1]!.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(calls[1]!.body!), {
      coinFrom: "XMR",
      networkFrom: "XMR",
      coinTo: "USDT",
      networkTo: "TRX",
      amount: 1.5,
      withdrawalAddress: TRON_MERCHANT,
      refundAddress: XMR_INVOICE,
      rateType: "float",
      slippage: 0.5,
    });
  });

  it("writes the amount and the slippage as exact JSON numbers, never through a float", async () => {
    const { swap, calls } = adapter({ rate: ok("rate-eth-xmr-float.json"), create: changed("create-built-btc-xmr.json", {}) });

    await swap.quote({ ...BTC_TO_XMR, from: "eth", amountIn: 123_456_789_012_345_678n, maxLossBps: 125 });

    assert.equal(new URL(calls[0]!.url).searchParams.get("amount"), "0.123456789012345678");
    assert.match(calls[1]!.body!, /"amount":0\.123456789012345678[,}]/);
    assert.match(calls[1]!.body!, /"slippage":1\.25[,}]/);
  });

  it("reads the swap id, the deposit address and the amount out, with the max-loss floor as the minimum out", async () => {
    const { swap } = adapter(xmrToUsdt());

    const answer = await swap.quote(XMR_TO_USDT);

    assert.equal(answer.kind, "ok", JSON.stringify(answer, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (answer.kind !== "ok") return;
    assert.equal(answer.quote.provider, "exolix");
    assert.equal(answer.quote.swapId, "exo0a1b2c3d4e5f");
    assert.equal(answer.quote.depositAddress, XMR_EXOLIX);
    assert.equal(answer.quote.amountIn, 1_500_000_000_000n);
    assert.equal(answer.quote.amountOut, 752_174_500n, "752.1745 USDT, exactly");
    // 753 USDT at our own prices, less the merchant's 50 bps.
    assert.equal(answer.quote.minAmountOut, 749_235_000n);
    assert.equal(answer.quote.deadline, undefined, "Exolix names no deadline");
    const record = answer.quote.record as { quoteRequest: { refundTo: string }; rate: unknown; transaction: { id: string; amountTo: string } };
    assert.equal(record.quoteRequest.refundTo, XMR_INVOICE, "kept where refundToOf finds it");
    assert.equal(record.transaction.id, "exo0a1b2c3d4e5f");
    assert.equal(record.transaction.amountTo, "752.1745", "numbers kept as Exolix wrote them");
  });

  it("quotes a coin into XMR too, the merchant's XMR address as the recipient", async () => {
    const { swap, calls } = adapter({ rate: ok("rate-btc-xmr-float.json"), create: ok("create-built-btc-xmr.json") });

    const answer = await swap.quote(BTC_TO_XMR);

    assert.equal(answer.kind, "ok");
    if (answer.kind !== "ok") return;
    assert.equal(answer.quote.amountOut, 118_096_740_000n, "0.11809674 XMR in piconero");
    assert.equal(answer.quote.depositAddress, BTC_EXOLIX);
    const body = JSON.parse(calls[1]!.body!) as Record<string, unknown>;
    assert.equal(body.withdrawalAddress, XMR_MERCHANT);
    assert.equal(body.refundAddress, BTC_INVOICE);
  });

  it("accepts Exolix's echo of the amount rounded through a float, but not another amount", async () => {
    // Exolix answered 0.12345678901234568 for 0.123456789012345678 ETH.
    const echo = await adapter({
      rate: ok("rate-eth-xmr-float.json"),
      create: {
        status: 200,
        text: raw("create-built-btc-xmr.json")
          .replace('"amount": 0.00094', '"amount": 0.12345678901234568')
          .replace('"amountTo": 0.11809674', '"amountTo": 0.43751321')
          .replace('"coinCode": "BTC"', '"coinCode": "ETH"')
          .replace('"network": "BTC"', '"network": "ETH"'),
      },
    }).swap.quote({ ...BTC_TO_XMR, from: "eth", amountIn: 123_456_789_012_345_678n, maxLossBps: 125 });
    assert.equal(echo.kind, "ok", echo.kind === "unavailable" ? echo.reason : "");

    const other = await adapter({
      rate: ok("rate-btc-xmr-float.json"),
      create: { status: 200, text: raw("create-built-btc-xmr.json").replace('"amount": 0.00094', '"amount": 0.00093') },
    }).swap.quote(BTC_TO_XMR);
    assert.equal(other.kind, "unavailable");
  });

  it("reads Exolix's below-minimum refusal as too small, with its minimum in smallest units, opening no transaction", async () => {
    const { swap, calls } = adapter({ rate: { status: 422, text: raw("rate-422-below-min.json") } });

    const answer = await swap.quote({ ...XMR_TO_USDT, from: "xmr", to: "btc", amountIn: 100_000_000n });

    assert.deepEqual(answer.kind === "too_small" && answer.minimumIn, 96_819_850_000n);
    assert.equal(calls.length, 1);
  });

  it("is unavailable above Exolix's maximum, for a pair it refuses, and when it can't be reached or answers garbage", async () => {
    for (const rate of [
      { status: 422, text: raw("rate-422-above-max.json") },
      { status: 422, text: raw("rate-422-pair.json") },
      { status: 200, text: "<html>maintenance</html>" },
      { status: 500, text: "" },
      undefined,
    ]) {
      const { swap, calls } = adapter({ rate, create: ok("create-built-xmr-usdttrx.json") });
      const answer = await swap.quote(XMR_TO_USDT);
      assert.equal(answer.kind, "unavailable", JSON.stringify(rate));
      assert.equal(calls.length, 1, "no transaction opened");
    }
  });

  it("sends nothing when the rate loses more than the merchant's max loss against our own price", async () => {
    // At 510 USD per XMR, 1.5 XMR is worth 765 USDT: 752.1745 is 168 bps less.
    const { swap, calls } = adapter(xmrToUsdt(), { prices: { ...PRICES, xmr: "510" } });

    const answer = await swap.quote(XMR_TO_USDT);

    assert.equal(answer.kind, "unavailable");
    assert.match(answer.kind === "unavailable" ? answer.reason : "", /max loss/);
    assert.equal(calls.length, 1, "no transaction opened");

    const wider = await adapter(xmrToUsdt(), { prices: { ...PRICES, xmr: "510" } }).swap.quote({ ...XMR_TO_USDT, maxLossBps: 200 });
    assert.equal(wider.kind, "ok", "168 bps is within a 200 bps max loss");
  });

  it("sends nothing when we have no price of our own for either coin", async () => {
    for (const missing of ["xmr", "usdttrx"] as const) {
      const { swap, calls } = adapter(xmrToUsdt(), { prices: { ...PRICES, [missing]: undefined } });
      const answer = await swap.quote(XMR_TO_USDT);
      assert.equal(answer.kind, "unavailable", missing);
      assert.equal(calls.length, 0, "Exolix is not even asked");
    }
  });

  it("refuses a transaction that pays out less than the max-loss floor, even after a good rate", async () => {
    const { swap } = adapter({
      rate: ok("rate-xmr-usdttrx-float.json"),
      create: { status: 200, text: raw("create-built-xmr-usdttrx.json").replace('"amountTo": 752.1745', '"amountTo": 749.2') },
    });
    assert.equal((await swap.quote(XMR_TO_USDT)).kind, "unavailable");
  });

  it("refuses a deposit that needs an extra id (memo): our payouts never send one", async () => {
    const { swap } = adapter({ rate: ok("rate-xmr-usdttrx-float.json"), create: changed("create-built-xmr-usdttrx.json", { depositExtraId: "100423" }) });
    const answer = await swap.quote(XMR_TO_USDT);
    assert.equal(answer.kind, "unavailable");
    assert.match(answer.kind === "unavailable" ? answer.reason : "", /extra id/);
  });

  it("refuses a transaction for another recipient, other coins, a fixed rate or with no deposit address", async () => {
    const coinTo = (fixture("create-built-xmr-usdttrx.json") as { coinTo: Record<string, unknown> }).coinTo;
    for (const fields of [
      { withdrawalAddress: "TSomeoneElse1111111111111111111111" },
      { coinTo: { ...coinTo, network: "ETH" } },
      { rateType: "fixed" },
      { depositAddress: "" },
      { id: "" },
    ]) {
      const { swap } = adapter({ rate: ok("rate-xmr-usdttrx-float.json"), create: changed("create-built-xmr-usdttrx.json", fields) });
      assert.equal((await swap.quote(XMR_TO_USDT)).kind, "unavailable", JSON.stringify(fields));
    }
  });

  it("reads a refused transaction as unavailable, or as too small when it names the minimum", async () => {
    const refused = adapter({ rate: ok("rate-xmr-usdttrx-float.json"), create: { status: 400, text: JSON.stringify({ message: "Invalid withdrawal address" }) } });
    assert.equal((await refused.swap.quote(XMR_TO_USDT)).kind, "unavailable");

    const small = adapter({ rate: ok("rate-xmr-usdttrx-float.json"), create: { status: 422, text: raw("rate-422-below-min.json") } });
    const answer = await small.swap.quote(XMR_TO_USDT);
    assert.equal(answer.kind, "too_small");
  });

  it("asks Exolix nothing when it is off or the pair is not its own", async () => {
    const off = adapter(xmrToUsdt(), { apiKey: "" });
    assert.equal((await off.swap.quote(XMR_TO_USDT)).kind, "unavailable");
    assert.equal(off.calls.length, 0);

    const near = adapter(xmrToUsdt());
    assert.equal((await near.swap.quote({ ...XMR_TO_USDT, from: "btc", to: "usdceth" })).kind, "unavailable");
    assert.equal(near.calls.length, 0);
  });
});

describe("an Exolix status", () => {
  const REF = { provider: "exolix", depositAddress: XMR_EXOLIX, swapId: "exo0a1b2c3d4e5f" };
  const withStatus = (status: string): Reply => ({
    status: 200,
    text: raw("create-built-xmr-usdttrx.json").replace('"status": "wait"', `"status": "${status}"`),
  });

  it("asks by the swap id, with the API key", async () => {
    const { swap, calls } = adapter({ transaction: withStatus("wait") });

    await swap.status(REF);

    assert.equal(calls[0]!.url, "https://exolix.com/api/v2/transactions/exo0a1b2c3d4e5f");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["api-key"], "test-exolix-key");
  });

  const MAPPED: Record<string, SwapStatusName> = {
    wait: "PENDING_DEPOSIT",
    confirmation: "KNOWN_DEPOSIT_TX",
    confirmed: "PROCESSING",
    exchanging: "PROCESSING",
    sending: "PROCESSING",
    success: "SUCCESS",
    overdue: "FAILED",
    refund: "PROCESSING",
    refunded: "REFUNDED",
  };
  for (const [exolix, ours] of Object.entries(MAPPED)) {
    it(`reads "${exolix}" as ${ours}`, async () => {
      const status = await adapter({ transaction: withStatus(exolix) }).swap.status(REF);
      assert.equal(status?.status, ours);
    });
  }

  it("reads a success: the delivery transaction, the deposit transaction and the amounts, exactly", async () => {
    const status = await adapter({ transaction: ok("transaction-built-xmr-usdttrx-success.json") }).swap.status(REF);
    assert.equal(status?.status, "SUCCESS");
    assert.deepEqual(status?.deliveryTxids, ["a7b9c3d1e5f70819a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70819"]);
    assert.deepEqual(status?.originTxids, ["4f1f1b6e0d43c1a0f2b8a6cd2c1e9d7f5b3a29180e6d4c2b1a0f9e8d7c6b5a49"]);
    assert.equal(status?.amountIn, 1_500_000_000_000n);
    assert.equal(status?.amountOut, 751_902_300n);
  });

  it("reads a refund: no delivery, and the reason with the refund transaction", async () => {
    const status = await adapter({ transaction: ok("transaction-built-xmr-usdttrx-refunded.json") }).swap.status(REF);
    assert.equal(status?.status, "REFUNDED");
    assert.deepEqual(status?.deliveryTxids, [], "hashOut is the refund, not a delivery");
    assert.match(status?.refundReason ?? "", /slippage limit/);
    assert.match(status?.refundReason ?? "", /c0ffee11223344556677889900aabbccddeeff00112233445566778899aabbcc/);
  });

  it("reads the documentation's own example", async () => {
    const docs = { provider: "exolix", depositAddress: (fixture("transaction-docs-example.json") as { depositAddress: string }).depositAddress, swapId: "ab93061434dd0s" };
    const status = await adapter({ transaction: ok("transaction-docs-example.json") }).swap.status(docs);
    assert.equal(status?.status, "PROCESSING");
    assert.equal(status?.amountIn, 640_000_000_000n);
    assert.equal(status?.amountOut, 65_841_840_000_000_000n);
    assert.deepEqual(status?.deliveryTxids, []);
  });

  it("answers undefined without a swap id, asking nothing", async () => {
    const { swap, calls } = adapter({ transaction: withStatus("wait") });
    assert.equal(await swap.status({ provider: "exolix", depositAddress: XMR_EXOLIX }), undefined);
    assert.equal(calls.length, 0);
  });

  it("answers undefined for an error, an unreadable reply, an unknown status or another swap's reply", async () => {
    for (const transaction of [
      { status: 404, text: JSON.stringify({ message: "Not found" }) },
      { status: 200, text: "garbage" },
      withStatus("lost"),
      changed("create-built-xmr-usdttrx.json", { depositAddress: BTC_EXOLIX }),
      changed("create-built-xmr-usdttrx.json", { id: "another" }),
      undefined,
    ]) {
      assert.equal(await adapter({ transaction }).swap.status(REF), undefined, JSON.stringify(transaction));
    }
  });

  it("still answers without an API key, so swaps in flight are followed after Exolix is turned off", async () => {
    const { swap, calls } = adapter({ transaction: withStatus("exchanging") }, { apiKey: "" });
    assert.equal((await swap.status(REF))?.status, "PROCESSING");
    assert.equal(calls[0]!.headers["api-key"], undefined);
  });
});

describe("telling Exolix about the deposit (start)", () => {
  it("has nothing to call: Exolix finds the deposit itself", async () => {
    const { swap, calls } = adapter({});
    assert.equal(await swap.start({ provider: "exolix", depositAddress: XMR_EXOLIX, swapId: "exo0a1b2c3d4e5f", txid: "t" }), true);
    assert.equal(calls.length, 0);
  });
});
