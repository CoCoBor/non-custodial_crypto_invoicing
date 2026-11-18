import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BlockbookApi } from "../../src/chains/blockbook.js";
import { getEvmPayments } from "../../src/chains/evm-payments.js";

// The EVM payment listing, parsed from Blockbook replies in the shapes of
// Blockbook's openapi.yaml (example EthereumTransaction). Not a recorded
// NOWNodes reply: none is available.

const DEPOSIT = "0x3B685307C8611AFb2A9E83EBc8743dc20480716E";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const OTHER_TOKEN = "0x4E15361FD6b4BB609Fa63C81A2be19d873717870";
const PAYER = "0xd446089cf19C3D3Eb1743BeF3A852293Fd2C7775";

const txid = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function tx(n: number, fields: Record<string, unknown> = {}) {
  return {
    txid: txid(n),
    vin: [{ n: 0, addresses: [PAYER], isAddress: true }],
    vout: [{ value: "0", n: 0, addresses: [DEPOSIT.toLowerCase()], isAddress: true }],
    blockHash: "0x10ea8cfecda89d6d864c1d919911f819c9febc2b455b48c9918cee3c6cdc4adb",
    blockHeight: 16529834,
    confirmations: 3,
    blockTime: 1675204631,
    value: "0",
    fees: "19141662404282012",
    ethereumSpecific: { status: 1, nonce: 505, gasLimit: 550941, gasUsed: 434686, gasPrice: "44035608242" },
    ...fields,
  };
}

function pages(...replies: unknown[]): BlockbookApi & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    get: async (path) => {
      paths.push(path);
      return replies[paths.length - 1];
    },
    post: async () => undefined,
  };
}

const page = (transactions: unknown[], extra: Record<string, unknown> = {}) => ({
  page: 1,
  totalPages: 1,
  itemsOnPage: 100,
  address: DEPOSIT,
  txs: transactions.length,
  unconfirmedTxs: 0,
  ...(transactions.length > 0 && { transactions }),
  ...extra,
});

const usdtTransfer = (to: string, value: string, contract = USDT) => ({
  type: "ERC20",
  standard: "ERC20",
  from: PAYER,
  to,
  contract,
  name: "Tether USD",
  symbol: "USDT",
  decimals: 6,
  value,
});

describe("EVM payments from a Blockbook listing", () => {
  it("lists a native payment with its txid, amount, confirmations and block time", async () => {
    const api = pages(page([tx(1, { value: "5615959129349132871", vout: [{ value: "5615959129349132871", n: 0, addresses: [DEPOSIT], isAddress: true }] })]));

    const payments = await getEvmPayments(api, DEPOSIT);

    assert.deepEqual(payments, [{ txid: txid(1), amount: 5615959129349132871n, confirmations: 3, seenAt: 1675204631000 }]);
    assert.deepEqual(api.paths, [`/address/${DEPOSIT}?details=txs&page=1&pageSize=100`]);
  });

  it("adds coin a contract sent to the deposit (internal transfer), only from a successful transaction", async () => {
    const internal = (status: number) => ({
      status,
      nonce: 1,
      internalTransfers: [
        { type: 0, from: PAYER, to: DEPOSIT, value: "700" },
        { type: 0, from: PAYER, to: USDT, value: "9" },
      ],
    });
    const api = pages(page([
      tx(2, { vout: [{ addresses: [USDT] }], ethereumSpecific: internal(1) }),
      tx(3, { vout: [{ addresses: [USDT] }], ethereumSpecific: internal(-1) }),
    ]));

    assert.deepEqual((await getEvmPayments(api, DEPOSIT))?.map((p) => [p.txid, p.amount]), [[txid(2), 700n]]);
  });

  it("skips a failed transaction, and keeps a pending one with 0 confirmations", async () => {
    const paid = { value: "10", vout: [{ addresses: [DEPOSIT] }] };
    const api = pages(page([
      tx(4, { ...paid, ethereumSpecific: { status: 0, nonce: 1 } }),
      tx(5, { ...paid, blockHeight: -1, confirmations: 0, ethereumSpecific: { status: -1, nonce: 2 } }),
    ]));

    assert.deepEqual((await getEvmPayments(api, DEPOSIT))?.map((p) => [p.txid, p.amount, p.confirmations]), [[txid(5), 10n, 0]]);
  });

  it("counts a token payment only for the token's own contract and for transfers to the deposit, summed per transaction", async () => {
    const api = pages(page([
      tx(6, { tokenTransfers: [usdtTransfer(DEPOSIT, "25000000"), usdtTransfer(DEPOSIT.toLowerCase(), "1"), usdtTransfer(PAYER, "5")] }),
      tx(7, { tokenTransfers: [usdtTransfer(DEPOSIT, "99", OTHER_TOKEN)] }),
      tx(8, { value: "10", vout: [{ addresses: [DEPOSIT] }] }),
    ]));

    assert.deepEqual((await getEvmPayments(api, DEPOSIT, USDT))?.map((p) => [p.txid, p.amount]), [[txid(6), 25000001n]]);
  });

  it("reads every page, once per transaction", async () => {
    const native = { value: "10", vout: [{ addresses: [DEPOSIT] }] };
    const api = pages(
      page([tx(9, native), tx(10, native)], { totalPages: 2 }),
      page([tx(10, native), tx(11, native)], { page: 2, totalPages: 2 }),
    );

    assert.deepEqual((await getEvmPayments(api, DEPOSIT))?.map((p) => p.txid), [txid(9), txid(10), txid(11)]);
  });

  it("answers undefined, never [], when a page fails or its transactions are missing", async () => {
    assert.equal(await getEvmPayments(pages(undefined), DEPOSIT), undefined);
    assert.equal(await getEvmPayments(pages({ ...page([]), txs: 2 }), DEPOSIT), undefined);
    assert.equal(await getEvmPayments(pages(page([tx(12)], { totalPages: 2 }), undefined), DEPOSIT), undefined);
    assert.equal(await getEvmPayments(pages(page([tx(13)], { totalPages: 51 })), DEPOSIT), undefined);
  });

  it("answers [] for an address with no transactions", async () => {
    assert.deepEqual(await getEvmPayments(pages(page([])), DEPOSIT), []);
  });
});
