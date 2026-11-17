import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import recorded from "../fixtures/blockbook/address-txs-page1.json" with { type: "json" };
import { getBtcPayments } from "../../src/invoice/invoice.function.js";

// tests/fixtures/blockbook/address-txs-page1.json is a real Blockbook reply for
// the genesis address, recorded 2026-09-20 with details=txs&pageSize=2. Both
// transactions pay it exactly 546 satoshi (dust) and send the rest elsewhere,
// which is precisely the case the output filter has to get right.
const ADDRESS = recorded.address;
const [TX_A, TX_B] = recorded.transactions;

/** A one-page listing built from the recorded reply, with fields overridden. */
function page(overrides: Record<string, unknown> = {}) {
  return { ...recorded, page: 1, totalPages: 1, ...overrides };
}

/** A real-looking 64-hex txid from a readable name (the parser rejects others). */
function txid(name: string) {
  return createHash("sha256").update(name).digest("hex");
}

/** A transaction shaped like the recorded ones, paying `outputs`. */
function tx(name: string, outputs: { value: string; to: string; isAddress?: boolean }[], confirmations = 0) {
  return {
    txid: txid(name),
    confirmations,
    vout: outputs.map((o, n) => ({ n, value: o.value, isAddress: o.isAddress ?? true, addresses: [o.to] })),
  };
}

type Reply = { body: unknown; status?: number } | Error;

/** Routes by the `page` query parameter, records every url it was asked. */
function fakeFetcher(pages: Record<number, Reply>) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const reply = pages[Number(url.searchParams.get("page"))];
    if (reply === undefined) throw new Error(`test has no page ${url.searchParams.get("page")}`);
    if (reply instanceof Error) throw reply;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  };
  return { fetcher, calls };
}

describe("getBtcPayments reading the recorded listing", () => {
  it("returns one payment per transaction that paid the address", async () => {
    const { fetcher } = fakeFetcher({ 1: { body: page() } });
    const payments = await getBtcPayments(ADDRESS, { fetcher });

    assert.deepEqual(payments?.map((p) => p.txid).sort(), [TX_A.txid, TX_B.txid].sort());
  });

  it("counts only the output that reached the address, not the whole transaction", async () => {
    // TX_A moves 10694 satoshi in total; 546 of it lands on the address and
    // 10148 goes back to the payer as change.
    const { fetcher } = fakeFetcher({ 1: { body: page() } });
    const payments = await getBtcPayments(ADDRESS, { fetcher });

    assert.equal(payments?.find((p) => p.txid === TX_A.txid)?.amount, 546n);
  });

  it("returns satoshi as a bigint without rescaling", async () => {
    const { fetcher } = fakeFetcher({ 1: { body: page() } });
    const payments = await getBtcPayments(ADDRESS, { fetcher });

    for (const p of payments ?? []) {
      assert.equal(typeof p.amount, "bigint");
    }
  });

  it("carries the confirmation count through", async () => {
    const { fetcher } = fakeFetcher({ 1: { body: page() } });
    const payments = await getBtcPayments(ADDRESS, { fetcher });

    // Both recorded transactions were still in the mempool.
    assert.deepEqual(payments?.map((p) => p.confirmations), [0, 0]);
  });
});

describe("getBtcPayments selecting outputs", () => {
  it("adds up several outputs to the address within one transaction", async () => {
    const body = page({ transactions: [tx("t1", [
      { value: "1000", to: ADDRESS },
      { value: "9000", to: "bc1qsomeoneelse" },
      { value: "500", to: ADDRESS },
    ])] });
    const { fetcher } = fakeFetcher({ 1: { body } });

    assert.equal((await getBtcPayments(ADDRESS, { fetcher }))?.[0]?.amount, 1500n);
  });

  it("skips a transaction that paid nothing to the address", async () => {
    // e.g. one that spent from it: every output goes elsewhere.
    const body = page({ transactions: [tx("t1", [{ value: "1000", to: "bc1qsomeoneelse" }])] });
    const { fetcher } = fakeFetcher({ 1: { body } });

    assert.deepEqual(await getBtcPayments(ADDRESS, { fetcher }), []);
  });

  it("ignores outputs that are not addresses, such as OP_RETURN", async () => {
    // Non-zero on purpose: a zero would be dropped by the amount check
    // regardless, and this test is for the isAddress flag alone.
    const body = page({ transactions: [tx("t1", [{ value: "546", to: ADDRESS, isAddress: false }])] });
    const { fetcher } = fakeFetcher({ 1: { body } });

    assert.deepEqual(await getBtcPayments(ADDRESS, { fetcher }), []);
  });

  it("returns an empty list for an address with no history", async () => {
    // Blockbook leaves `transactions` out entirely rather than sending [].
    const { transactions: _none, ...fresh } = page({ txs: 0, unconfirmedTxs: 0 });
    const { fetcher } = fakeFetcher({ 1: { body: fresh } });

    assert.deepEqual(await getBtcPayments(ADDRESS, { fetcher }), []);
  });

  it("returns undefined when the listing counts transactions but leaves out their details", async () => {
    // [] here would read as "nothing paid" for an address that has payments.
    const { transactions: _none, ...detailsMissing } = page({ txs: 2 });
    const { fetcher } = fakeFetcher({ 1: { body: detailsMissing } });

    assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined);
  });
});

describe("getBtcPayments walking pages", () => {
  it("reads every page and merges the payments", async () => {
    const { fetcher, calls } = fakeFetcher({
      1: { body: page({ totalPages: 2, transactions: [tx("t1", [{ value: "100", to: ADDRESS }])] }) },
      2: { body: page({ page: 2, totalPages: 2, transactions: [tx("t2", [{ value: "200", to: ADDRESS }])] }) },
    });
    const payments = await getBtcPayments(ADDRESS, { fetcher });

    assert.equal(calls.length, 2);
    assert.deepEqual(payments?.map((p) => p.amount).sort(), [100n, 200n]);
  });

  it("counts a transaction once even if paging shows it twice", async () => {
    // A payment arriving mid-listing shifts everything down a slot, so the
    // last item of page 1 reappears as the first of page 2.
    const shared = tx("t-shared", [{ value: "100", to: ADDRESS }]);
    const { fetcher } = fakeFetcher({
      1: { body: page({ totalPages: 2, transactions: [tx("t1", [{ value: "1", to: ADDRESS }]), shared] }) },
      2: { body: page({ page: 2, totalPages: 2, transactions: [shared, tx("t2", [{ value: "2", to: ADDRESS }])] }) },
    });
    const payments = await getBtcPayments(ADDRESS, { fetcher });

    assert.equal(payments?.length, 3);
    assert.equal(payments?.filter((p) => p.txid === txid("t-shared")).length, 1);
  });

  it("gives up rather than return a partial listing when a later page fails", async () => {
    const { fetcher } = fakeFetcher({
      1: { body: page({ totalPages: 2, transactions: [tx("t1", [{ value: "100", to: ADDRESS }])] }) },
      2: new Error("ECONNRESET"),
    });

    assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined);
  });

  it("refuses an implausibly long listing rather than trust it is complete", async () => {
    const { fetcher, calls } = fakeFetcher(
      Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i + 1, { body: page({ page: i + 1, totalPages: 60 }) }])),
    );

    assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined);
    assert.ok(calls.length <= 51, `fetched ${calls.length} pages before giving up`);
  });
});

describe("getBtcPayments when the request fails", () => {
  // Every failure is undefined, never []. An empty list would tell the
  // caller "nothing has been paid" and could zero out a recorded payment.
  it("returns undefined when the request throws", async () => {
    const { fetcher } = fakeFetcher({ 1: new Error("timeout") });
    assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined);
  });

  it("returns undefined on a non-2xx status even with a well-formed body", async () => {
    const { fetcher } = fakeFetcher({ 1: { body: page(), status: 503 } });
    assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined);
  });

  it("returns undefined for the 401 an expired api key produces", async () => {
    const { fetcher } = fakeFetcher({ 1: { body: "Unknown API_key", status: 401 } });
    assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined);
  });

  it("returns undefined when the body is not json", async () => {
    const { fetcher } = fakeFetcher({ 1: { body: "<html>Bad Gateway</html>" } });
    assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined);
  });

  it("returns undefined when an output value is not a satoshi integer string", async () => {
    for (const bad of ["0.00000546", "-546", "546e0", 546, ""]) {
      const body = page({ transactions: [{ ...tx("t1", [{ value: "546", to: ADDRESS }]), vout: [{ n: 0, value: bad, isAddress: true, addresses: [ADDRESS] }] }] });
      const { fetcher } = fakeFetcher({ 1: { body } });
      assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined, `accepted value ${JSON.stringify(bad)}`);
    }
  });

  it("returns undefined when a required field is missing", async () => {
    for (const field of ["txid", "confirmations", "vout"] as const) {
      const { [field]: _dropped, ...broken } = tx("t1", [{ value: "546", to: ADDRESS }]);
      const { fetcher } = fakeFetcher({ 1: { body: page({ transactions: [broken] }) } });
      assert.equal(await getBtcPayments(ADDRESS, { fetcher }), undefined, `accepted a transaction without ${field}`);
    }
  });
});

describe("getBtcPayments building the request", () => {
  it("asks blockbook for full transactions on the documented path", async () => {
    const { fetcher, calls } = fakeFetcher({ 1: { body: page() } });
    await getBtcPayments(ADDRESS, { fetcher });

    const url = calls[0]!.url;
    assert.equal(url.origin, "https://btcbook.nownodes.io");
    assert.equal(url.pathname, `/api/v2/address/${ADDRESS}`);
    assert.equal(url.searchParams.get("details"), "txs");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("pageSize"), "100");
  });

  it("url-encodes the address rather than splicing it into the path", async () => {
    const { fetcher, calls } = fakeFetcher({ 1: { body: page() } });
    await getBtcPayments("../../admin?x=1", { fetcher });

    assert.equal(calls[0]!.url.pathname, "/api/v2/address/..%2F..%2Fadmin%3Fx%3D1");
  });

  it("sends the api key and refuses redirects", async () => {
    const { fetcher, calls } = fakeFetcher({ 1: { body: page() } });
    await getBtcPayments(ADDRESS, { fetcher });

    const init = calls[0]!.init;
    assert.ok(typeof (init?.headers as Record<string, string>)["api-key"] === "string");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
  });
});
