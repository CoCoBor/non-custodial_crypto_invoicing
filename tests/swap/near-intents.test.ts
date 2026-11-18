import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ASSET_IDS } from "../../src/assets/payout-address.js";
import cryptos from "../../src/storage/cryptos.json" with { type: "json" };
import { createNearIntentsSwap, nearAssetId } from "../../src/swap/near.js";
import type { SwapRequest } from "../../src/swap/swap-port.js";

// The NEAR Intents 1Click adapter, tested by parsing replies (no network).
// Recorded 2026-11-18 with no JWT and no funds: tokens.json (GET /v0/tokens),
// quote-dry-btc-usdceth.json (one dry quote), quote-400-too-low.json and
// quote-400-recipient.json (dry quotes that were refused). Built from the
// recorded dry reply plus the fields the OpenAPI spec
// (https://1click.chaindefuser.com/docs/v0/openapi.yaml) says a real quote and
// a status reply carry: quote-built-*.json and status-built-*.json.

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/near/${name}`, import.meta.url), "utf8"));

const NOW = Date.parse("2026-11-18T08:00:00Z");
const DEPOSIT = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const MERCHANT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const REQUEST: SwapRequest = {
  from: "btc",
  to: "usdceth",
  amountIn: 100_000n,
  recipient: MERCHANT,
  refundTo: DEPOSIT,
  maxLossBps: 250,
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(status: number, reply: unknown) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function adapter(status: number, reply: unknown, jwt = "test-jwt") {
  const fake = fakeFetch(status, reply);
  return { swap: createNearIntentsSwap({ fetch: fake.fetch, jwt, now: () => NOW }), calls: fake.calls };
}

describe("NEAR asset ids", () => {
  type Token = { assetId: string; blockchain: string; decimals: number; contractAddress?: string };
  const tokens = fixture("tokens.json") as Token[];
  const NEAR_CHAIN: Record<string, string> = { trx: "tron" };

  for (const asset of ASSET_IDS) {
    const id = nearAssetId(asset);
    if (id === undefined) continue;
    it(`${asset} is ${id} in NEAR's recorded token list, with its chain, contract and decimals`, () => {
      const coin = cryptos[asset] as { chain: { symbol: string }; decimal: number; contract_address?: string; mint_address?: string; jetton_master?: string };
      const token = tokens.find((t) => t.assetId === id);
      assert.ok(token, "not in the token list");
      assert.equal(token.blockchain, NEAR_CHAIN[coin.chain.symbol] ?? coin.chain.symbol);
      assert.equal(token.decimals, coin.decimal);
      const contract = coin.contract_address ?? coin.mint_address ?? coin.jetton_master;
      if (contract === undefined) assert.equal(token.contractAddress, undefined);
      else assert.equal(token.contractAddress?.toLowerCase(), contract.toLowerCase());
    });
  }

  it("has no XMR: NEAR does not list Monero (XMR swaps are Exolix's, ticket 24)", () => {
    assert.equal(nearAssetId("xmr"), undefined);
    assert.ok(!tokens.some((t) => t.blockchain === "xmr"));
  });

  it("knows every launch asset NEAR lists, so swap mode offers them", () => {
    for (const asset of ["btc", "ltc", "eth", "sol", "ton", "bsc", "usdteth", "usdceth", "daieth", "usdtsol", "usdcsol", "usdtton", "usdttrx"] as const) {
      assert.ok(nearAssetId(asset), asset);
    }
  });
});

describe("a 1Click quote", () => {
  it("asks for an EXACT_INPUT swap with the merchant's max loss, refunds to the deposit, pays the merchant", async () => {
    const { swap, calls } = adapter(201, fixture("quote-built-live-btc-usdceth.json"));

    await swap.quote(REQUEST);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://1click.chaindefuser.com/v0/quote");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.authorization, "Bearer test-jwt");
    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.dry, false);
    assert.equal(body.swapType, "EXACT_INPUT");
    assert.equal(body.slippageTolerance, 250);
    assert.equal(body.originAsset, "nep141:btc.omft.near");
    assert.equal(body.destinationAsset, "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near");
    assert.equal(body.amount, "100000");
    assert.equal(body.refundTo, DEPOSIT);
    assert.equal(body.refundType, "ORIGIN_CHAIN");
    assert.equal(body.recipient, MERCHANT);
    assert.equal(body.recipientType, "DESTINATION_CHAIN");
    assert.equal(body.depositType, "ORIGIN_CHAIN");
    assert.equal(body.depositMode, "SIMPLE");
    assert.equal(body.deadline, new Date(NOW + 24 * 60 * 60 * 1000).toISOString());
  });

  it("sends no Authorization header without a JWT", async () => {
    const { swap, calls } = adapter(201, fixture("quote-built-live-btc-usdceth.json"), "");
    await swap.quote(REQUEST);
    assert.equal(calls[0]!.headers.authorization, undefined);
  });

  it("reads the deposit address, the amounts and the deadline", async () => {
    const { swap } = adapter(201, fixture("quote-built-live-btc-usdceth.json"));

    const answer = await swap.quote(REQUEST);

    assert.equal(answer.kind, "ok");
    if (answer.kind !== "ok") return;
    assert.equal(answer.quote.provider, "near_intents");
    assert.equal(answer.quote.depositAddress, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    assert.equal(answer.quote.amountIn, 100_000n);
    assert.equal(answer.quote.amountOut, 64_414_580n);
    assert.equal(answer.quote.minAmountOut, 64_092_507n);
    assert.equal(answer.quote.deadline, Date.parse("2026-11-19T07:58:31.000Z"));
    assert.ok(answer.quote.record, "keeps the signed reply for disputes");
  });

  it("refuses a reply with no deposit address (a dry reply), as unavailable", async () => {
    const { swap } = adapter(201, fixture("quote-dry-btc-usdceth.json"));
    assert.equal((await swap.quote(REQUEST)).kind, "unavailable");
  });

  it("refuses a quote whose amountIn is not exactly the amount asked", async () => {
    const reply = fixture("quote-built-live-btc-usdceth.json") as { quote: Record<string, unknown> };
    reply.quote.amountIn = "99999";
    const { swap } = adapter(201, reply);
    assert.equal((await swap.quote(REQUEST)).kind, "unavailable");
  });

  it("refuses a quote that needs a deposit memo: we never send one", async () => {
    const reply = fixture("quote-built-live-btc-usdceth.json") as { quote: Record<string, unknown> };
    reply.quote.depositMemo = "1111111";
    const { swap } = adapter(201, reply);
    assert.equal((await swap.quote(REQUEST)).kind, "unavailable");
  });

  it("refuses a quote whose deadline leaves less than 4 hours", async () => {
    const reply = fixture("quote-built-live-btc-usdceth.json") as { quote: Record<string, unknown> };
    reply.quote.deadline = new Date(NOW + 3 * 60 * 60 * 1000).toISOString();
    const { swap } = adapter(201, reply);
    assert.equal((await swap.quote(REQUEST)).kind, "unavailable");
  });

  it("reads NEAR's 'amount is too low' refusal as too small, with NEAR's minimum", async () => {
    const { swap } = adapter(400, fixture("quote-400-too-low.json"));

    const answer = await swap.quote(REQUEST);

    assert.deepEqual(answer, { kind: "too_small", minimumIn: 8300n, reason: "Amount is too low for bridge, try at least 8300" });
  });

  it("reads any other refusal as unavailable", async () => {
    const { swap } = adapter(400, fixture("quote-400-recipient.json"));
    assert.deepEqual(await swap.quote(REQUEST), { kind: "unavailable", reason: "NEAR refused the quote (400): recipient is not valid" });
  });

  it("is unavailable when NEAR can't be reached or answers garbage", async () => {
    const down = createNearIntentsSwap({
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
      jwt: "test-jwt",
      now: () => NOW,
    });
    assert.equal((await down.quote(REQUEST)).kind, "unavailable");
    assert.equal((await adapter(200, "<html>").swap.quote(REQUEST)).kind, "unavailable");
    assert.equal((await adapter(500, { message: "internal" }).swap.quote(REQUEST)).kind, "unavailable");
  });

  it("is unavailable for an asset NEAR does not list, without asking NEAR", async () => {
    const { swap, calls } = adapter(201, fixture("quote-built-live-btc-usdceth.json"));
    assert.equal((await swap.quote({ ...REQUEST, from: "xmr" })).kind, "unavailable");
    assert.equal(calls.length, 0);
  });

  it("supports a pair only when NEAR lists both sides and they differ", () => {
    const { swap } = adapter(201, {});
    assert.equal(swap.supports("btc", "usdceth"), true);
    assert.equal(swap.supports("xmr", "usdceth"), false);
    assert.equal(swap.supports("btc", "xmr"), false);
    assert.equal(swap.supports("btc", "btc"), false);
  });
});

const REF = { provider: "near_intents", depositAddress: "x" };

describe("a 1Click status", () => {
  it("asks by deposit address, with the JWT", async () => {
    const { swap, calls } = adapter(200, fixture("status-built-processing.json"));

    await swap.status({ provider: "near_intents", depositAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" });

    assert.equal(calls[0]!.url, "https://1click.chaindefuser.com/v0/status?depositAddress=bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    assert.equal(calls[0]!.headers.authorization, "Bearer test-jwt");
  });

  it("reads a swap in progress", async () => {
    const { swap } = adapter(200, fixture("status-built-processing.json"));
    const status = await swap.status(REF);
    assert.equal(status?.status, "PROCESSING");
    assert.deepEqual(status?.deliveryTxids, []);
    assert.deepEqual(status?.originTxids, ["9b1a4f0c3e2d5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"]);
  });

  it("reads a success: the amount out and the transactions that delivered it", async () => {
    const { swap } = adapter(200, fixture("status-built-success.json"));
    const status = await swap.status(REF);
    assert.equal(status?.status, "SUCCESS");
    assert.equal(status?.amountOut, 64_400_000n);
    assert.equal(status?.refundedAmount, 0n);
    assert.deepEqual(status?.deliveryTxids, ["0x5f6e7d8c9b0a1f2e3d4c5b6a79881726354a5b6c7d8e9f0a1b2c3d4e5f607182"]);
  });

  it("reads a refund: how much went back, and why", async () => {
    const { swap } = adapter(200, fixture("status-built-refunded.json"));
    const status = await swap.status(REF);
    assert.equal(status?.status, "REFUNDED");
    assert.equal(status?.refundedAmount, 98_100n);
    assert.equal(status?.refundReason, "PARTIAL_DEPOSIT");
  });

  it("answers undefined for an unknown deposit address, an error or an unreadable reply", async () => {
    assert.equal(await adapter(404, { message: "Deposit address not found" }).swap.status(REF), undefined);
    assert.equal(await adapter(500, "oops").swap.status(REF), undefined);
    const bad = fixture("status-built-success.json") as Record<string, unknown>;
    bad.status = "DONE";
    assert.equal(await adapter(200, bad).swap.status(REF), undefined);
  });
});

describe("telling 1Click about the deposit (start)", () => {
  it("submits the deposit transaction's hash for the deposit address", async () => {
    const { swap, calls } = adapter(200, fixture("status-built-processing.json"));

    assert.equal(await swap.start({ provider: "near_intents", depositAddress: "bc1qdeposit", txid: "abc123" }), true);

    assert.equal(calls[0]!.url, "https://1click.chaindefuser.com/v0/deposit/submit");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(calls[0]!.body, { txHash: "abc123", depositAddress: "bc1qdeposit" });
  });

  it("reports false when NEAR refuses it; it is only a hint", async () => {
    assert.equal(await adapter(400, { message: "unknown" }).swap.start({ provider: "near_intents", depositAddress: "a", txid: "b" }), false);
  });
});
