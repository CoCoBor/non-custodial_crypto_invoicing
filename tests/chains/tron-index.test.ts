import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTronApi, createTronBlockbookIndex, createTronGridIndex } from "../../src/chains/tron-api.js";

// The Tron payment index clients, on stubbed replies. The index only names
// transactions; amounts come from the full node (tests/chains/tron/).

const DEPOSIT = "TVzYu8aczxtWAF2JmcEZEUapsYqtUWDU1p";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const tx = (n: number) => n.toString(16).padStart(64, "0");

function stub(replies: (url: URL, init: RequestInit) => { status?: number; body: unknown }) {
  const seen: { url: URL; init: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, init: init ?? {} });
    const { status = 200, body } = replies(url, init ?? {});
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, seen };
}

describe("the Blockbook index (details=txids)", () => {
  it("reads every page, normalises txids, and sends the api-key header without following redirects", async () => {
    const { fetcher, seen } = stub((url) => {
      const page = Number(url.searchParams.get("page"));
      return { body: { page, totalPages: 2, txids: page === 1 ? ["0x" + tx(1).toUpperCase()] : [tx(2)] } };
    });
    const index = createTronBlockbookIndex({ baseUrl: "https://bb.example/api/v2", fetcher });

    assert.deepEqual(await index.transferTxids(DEPOSIT, USDT), [tx(1), tx(2)]);
    assert.equal(seen[0]!.url.pathname, `/api/v2/address/${DEPOSIT}`);
    assert.equal(seen[0]!.url.searchParams.get("details"), "txids");
    assert.ok("api-key" in (seen[0]!.init.headers as Record<string, string>));
    assert.equal(seen[0]!.init.redirect, "error");
  });

  it("reads an address with no transactions as an empty list", async () => {
    const { fetcher } = stub(() => ({ body: { page: 1, totalPages: 0 } }));
    assert.deepEqual(await createTronBlockbookIndex({ baseUrl: "https://bb.example/api/v2", fetcher }).transferTxids(DEPOSIT, USDT), []);
  });

  it("answers undefined for a failed call, a wrong page, a bad txid, or more pages than it reads", async () => {
    const cases = [
      () => ({ status: 500, body: {} }),
      () => ({ body: { page: 2, totalPages: 3, txids: [tx(1)] } }),
      () => ({ body: { page: 1, totalPages: 1, txids: ["nope"] } }),
      (url: URL) => ({ body: { page: Number(url.searchParams.get("page")), totalPages: 11, txids: [tx(1)] } }),
    ];
    for (const reply of cases) {
      const { fetcher } = stub(reply);
      assert.equal(await createTronBlockbookIndex({ baseUrl: "https://bb.example/api/v2", fetcher }).transferTxids(DEPOSIT, USDT), undefined);
    }
  });
});

describe("the TronGrid-style index (/v1/accounts/{address}/transactions/trc20)", () => {
  it("asks for incoming transfers of the contract only, and follows the fingerprint", async () => {
    const { fetcher, seen } = stub((url) =>
      url.searchParams.get("fingerprint") === null
        ? { body: { success: true, data: [{ transaction_id: tx(3) }], meta: { fingerprint: "next" } } }
        : { body: { success: true, data: [{ transaction_id: tx(4) }], meta: {} } },
    );
    const index = createTronGridIndex({ baseUrl: "https://grid.example", sendApiKey: false, fetcher });

    assert.deepEqual(await index.transferTxids(DEPOSIT, USDT), [tx(3), tx(4)]);
    assert.equal(seen[0]!.url.pathname, `/v1/accounts/${DEPOSIT}/transactions/trc20`);
    assert.equal(seen[0]!.url.searchParams.get("contract_address"), USDT);
    assert.equal(seen[0]!.url.searchParams.get("only_to"), "true");
    assert.equal(seen[1]!.url.searchParams.get("fingerprint"), "next");
    assert.equal("api-key" in (seen[0]!.init.headers as Record<string, string>), false);
  });

  it("answers undefined for an unsuccessful reply", async () => {
    const { fetcher } = stub(() => ({ body: { success: false, error: "rate limited" } }));
    assert.equal(await createTronGridIndex({ baseUrl: "https://grid.example", fetcher }).transferTxids(DEPOSIT, USDT), undefined);
  });
});

describe("the full-node client", () => {
  it("answers undefined for java-tron's HTTP-200 error replies and passes {} (not found) through", async () => {
    const { fetcher } = stub((url) => (url.pathname.endsWith("bad") ? { body: { Error: "boom" } } : { body: {} }));
    const api = createTronApi({ baseUrl: "https://node.example", sendApiKey: false, fetcher });

    assert.equal(await api.post("/wallet/bad", {}), undefined);
    assert.deepEqual(await api.post("/wallet/gettransactioninfobyid", { value: tx(1) }), {});
  });
});
