import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AbiCoder, getAddress, Transaction, Wallet } from "ethers";

import type { BlockbookApi } from "../../../src/chains/blockbook.js";
import type { ChainAdapter, PayoutCheckpoint, PayoutRequest, PayoutResult } from "../../../src/chains/adapter.js";
import type { EvmRpc } from "../../../src/chains/evm-rpc.js";
import { createEvmNativeAdapter, createEvmTokenAdapter, EVM_CHAINS } from "../../../src/chains/evm.js";
import { parseFeeRate } from "../../../src/money/payout-split.js";
import { sealSecret } from "../../../src/security/secret-envelope.js";
import cryptos from "../../../src/storage/cryptos.json" with { type: "json" };

// The adapter seam with a fake JSON-RPC node: what the adapter decides when a
// saved transaction's receipt is not readable yet but its sender's nonce has
// already moved (fix ticket D). A load-balanced provider, or anvil under load,
// can answer the nonce from a newer state than the receipt.

const LOST_AFTER = EVM_CHAINS.eth.lostAfterBlocks;
const USDT = cryptos.usdteth.contract_address;

type Mined = { block: bigint; receiptVisible: boolean; txVisible: boolean; receiptLagReads: number };

/** A fake node: a mempool, a chain head, and per-transaction visibility switches. */
function fakeNode() {
  let head = 100n;
  const nonceUsedAt = new Map<string, Map<number, bigint>>();
  const pool = new Map<string, { from: string; nonce: number }>();
  const mined = new Map<string, Mined>();
  const known = new Map<string, { from: string; nonce: number; to: string; value: bigint; data: string }>();
  const balances = new Map<string, bigint>();
  const tokenBalances = new Map<string, bigint>();
  const sent: string[] = [];
  const calls: string[] = [];
  let failHistoricalNonce = false;

  const usedBy = (address: string) => {
    const key = getAddress(address);
    if (!nonceUsedAt.has(key)) nonceUsedAt.set(key, new Map());
    return nonceUsedAt.get(key)!;
  };
  const countAt = (address: string, block: bigint) =>
    BigInt([...usedBy(address).values()].filter((at) => at <= block).length);

  const hex = (n: bigint) => "0x" + n.toString(16);

  const rpc: EvmRpc = {
    call: async (method, params) => {
      calls.push(method);
      switch (method) {
        case "eth_chainId":
          return "0x1";
        case "eth_gasPrice":
          return hex(1_000_000_000n);
        case "eth_blockNumber":
          return hex(head);
        case "eth_getBlockByNumber":
          return { number: hex(head), baseFeePerGas: "0x0" };
        case "eth_estimateGas":
          return hex(50_000n);
        case "eth_getBalance":
          return hex(balances.get(getAddress(String(params[0]))) ?? 0n);
        case "eth_getCode":
          return "0x";
        case "eth_call": {
          const owner = "0x" + String((params[0] as { data: string }).data).slice(-40);
          return "0x" + (tokenBalances.get(getAddress(owner)) ?? 0n).toString(16).padStart(64, "0");
        }
        case "eth_getTransactionCount": {
          const [address, tag] = params as [string, string];
          if (tag === "latest") return hex(countAt(address, head));
          if (tag === "pending") {
            const inPool = [...pool.values()].filter((p) => getAddress(p.from) === getAddress(address)).length;
            return hex(countAt(address, head) + BigInt(inPool));
          }
          if (failHistoricalNonce) return undefined;
          return hex(countAt(address, BigInt(tag)));
        }
        case "eth_sendRawTransaction": {
          const tx = Transaction.from(String(params[0]));
          const txid = tx.hash!.toLowerCase();
          sent.push(txid);
          if (BigInt(tx.nonce) < countAt(tx.from!, head)) return undefined; // nonce too low
          known.set(txid, { from: tx.from!, nonce: tx.nonce, to: tx.to!, value: tx.value, data: tx.data });
          if (!mined.has(txid)) pool.set(txid, { from: tx.from!, nonce: tx.nonce });
          return txid;
        }
        case "eth_getTransactionReceipt": {
          const txid = String(params[0]).toLowerCase();
          const m = mined.get(txid);
          if (m === undefined || !m.receiptVisible) return null;
          if (m.receiptLagReads > 0) {
            m.receiptLagReads -= 1;
            return null;
          }
          return { transactionHash: txid, status: "0x1", logs: logsOf(txid) };
        }
        case "eth_getTransactionByHash": {
          const txid = String(params[0]).toLowerCase();
          const m = mined.get(txid);
          if (m !== undefined) return m.txVisible ? { hash: txid, blockNumber: hex(m.block) } : null;
          return pool.has(txid) ? { hash: txid, blockNumber: null } : null;
        }
        default:
          throw new Error(`fake node: unexpected ${method}`);
      }
    },
  };

  /** A token transfer's Transfer log, so the adapter's proof can read it. */
  function logsOf(txid: string) {
    const tx = known.get(txid)!;
    if (tx.data === "0x") return [];
    const [to, amount] = AbiCoder.defaultAbiCoder().decode(["address", "uint256"], "0x" + tx.data.slice(10));
    const topic = (address: string) => "0x" + address.slice(2).toLowerCase().padStart(64, "0");
    return [{
      address: tx.to,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(tx.from), topic(String(to))],
      data: "0x" + BigInt(amount).toString(16).padStart(64, "0"),
    }];
  }

  return {
    rpc,
    sent,
    calls,
    get head() {
      return head;
    },
    setBalance: (address: string, wei: bigint) => balances.set(getAddress(address), wei),
    setTokenBalance: (address: string, units: bigint) => tokenBalances.set(getAddress(address), units),
    /** Mines every pooled transaction in a new block; visibility as given (the race: hidden). */
    mineAll(visibility: Partial<Omit<Mined, "block">> = {}) {
      head += 1n;
      for (const [txid, p] of pool) {
        usedBy(p.from).set(p.nonce, head);
        mined.set(txid, { block: head, receiptVisible: true, txVisible: true, receiptLagReads: 0, ...visibility });
      }
      pool.clear();
    },
    /** Makes every mined transaction readable, as the lagging node catches up. */
    revealAll() {
      for (const m of mined.values()) Object.assign(m, { receiptVisible: true, txVisible: true, receiptLagReads: 0 });
    },
    /** Another transaction from `address` takes `nonce` in a new block; our pooled one is dropped. */
    steal(address: string, nonce: number) {
      head += 1n;
      usedBy(address).set(nonce, head);
      for (const [txid, p] of pool) if (getAddress(p.from) === getAddress(address) && p.nonce === nonce) pool.delete(txid);
    },
    advance(blocks: bigint) {
      head += blocks;
    },
    failHistoricalNonce(on: boolean) {
      failHistoricalNonce = on;
    },
  };
}

const index: BlockbookApi = { get: async () => undefined } as unknown as BlockbookApi;

function show(result: PayoutResult): string {
  return JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

async function nativeSetup() {
  const node = fakeNode();
  const adapter = createEvmNativeAdapter({ rpc: node.rpc, index, chain: "eth", platformAddress: Wallet.createRandom().address });
  const deposit = await adapter.newDeposit();
  node.setBalance(deposit.address, 10n ** 18n);
  const saved: PayoutCheckpoint[] = [];
  const request = (): PayoutRequest => ({
    depositAddress: deposit.address,
    depositKey: deposit.key,
    destination: Wallet.createRandom().address,
    destinationKind: "merchant_payout",
    receiveAsset: "eth",
    feeRate: parseFeeRate("0.05")!,
    minimumAmount: 1n,
    checkpoint: saved.at(-1),
    saveCheckpoint: async (next) => {
      saved.push(next);
      return true;
    },
  });
  // First call: signs, saves, broadcasts both transfers (nonces 0 and 1).
  const first = await adapter.payout(request());
  assert.equal(first.status, "pending", show(first));
  assert.equal(node.sent.length, 2);
  return { node, adapter, deposit, saved, request };
}

describe("EVM payout: a saved deposit transfer whose receipt is not readable yet", () => {
  it("waits (pending, not failed) while the nonce has moved but the receipt and transaction are not readable yet; then pays", async () => {
    const { node, adapter, request } = await nativeSetup();
    node.mineAll({ receiptVisible: false, txVisible: false });

    const raced = await adapter.payout(request());
    assert.equal(raced.status, "pending", show(raced));

    node.revealAll();
    const paid = await adapter.payout(request());
    assert.equal(paid.status, "paid", show(paid));
    if (paid.status === "paid") assert.deepEqual(paid.transfers.map((t) => t.kind), ["merchant_payout", "platform_fee"]);
  });

  it("waits while its transaction is known but the receipt node is behind, even long after the nonce moved", async () => {
    const { node, adapter, request } = await nativeSetup();
    node.mineAll({ receiptVisible: false, txVisible: true });
    node.advance(LOST_AFTER * 3n);

    const result = await adapter.payout(request());
    assert.equal(result.status, "pending", show(result));
  });

  it("follows the receipt that shows up on the re-check after the nonce looked used long ago", async () => {
    const { node, adapter, request } = await nativeSetup();
    node.mineAll({ receiptLagReads: 1, txVisible: false });
    node.advance(LOST_AFTER * 3n);

    const result = await adapter.payout(request());
    assert.equal(result.status, "paid", show(result));
  });

  it("waits, and does not fail, while another transaction took the nonce fewer than the chain's lost-after blocks ago", async () => {
    const { node, adapter, deposit, request } = await nativeSetup();
    node.steal(deposit.address, 0);
    node.advance(LOST_AFTER - 2n);

    const result = await adapter.payout(request());
    assert.equal(result.status, "pending", show(result));
  });

  it("waits when the node can't answer the nonce at an older block", async () => {
    const { node, adapter, deposit, request } = await nativeSetup();
    node.steal(deposit.address, 0);
    node.advance(LOST_AFTER * 3n);
    node.failHistoricalNonce(true);

    const result = await adapter.payout(request());
    assert.equal(result.status, "pending", show(result));
  });

  it("fails with a where-the-money-is message once another transaction took the nonce long enough ago and ours is unknown", async () => {
    const { node, adapter, deposit, request } = await nativeSetup();
    node.steal(deposit.address, 0);
    node.advance(LOST_AFTER);

    const result = await adapter.payout(request());
    assert.equal(result.status, "failed", show(result));
    if (result.status === "failed") {
      assert.match(result.message, /can never land, because another transaction used nonce 0/);
      assert.match(result.message, new RegExp(deposit.address));
    }
  });
});

describe("EVM payout: a saved gas top-up whose receipt is not readable yet", () => {
  async function tokenSetup() {
    const node = fakeNode();
    const gasWallet = Wallet.createRandom();
    node.setBalance(gasWallet.address, 10n ** 18n);
    const adapter: ChainAdapter = createEvmTokenAdapter({
      rpc: node.rpc,
      index,
      chain: "eth",
      asset: "usdteth",
      platformAddress: Wallet.createRandom().address,
      gasWalletKey: sealSecret("ethereum-gas-wallet-key", gasWallet.privateKey),
      getPrice: async (asset) => (asset === "eth" ? "3000" : "1"),
    });
    const deposit = await adapter.newDeposit();
    node.setTokenBalance(deposit.address, 100_000_000n);
    const saved: PayoutCheckpoint[] = [];
    const request = (): PayoutRequest => ({
      depositAddress: deposit.address,
      depositKey: deposit.key,
      destination: Wallet.createRandom().address,
      destinationKind: "merchant_payout",
      receiveAsset: "usdteth",
      feeRate: parseFeeRate("0.05")!,
      minimumAmount: 1n,
      checkpoint: saved.at(-1),
      saveCheckpoint: async (next) => {
        saved.push(next);
        return true;
      },
    });
    const first = await adapter.payout(request());
    assert.equal(first.status, "pending", show(first));
    assert.equal(node.sent.length, 1, "only the top-up is sent first");
    const topUp = saved[0]!.plan.transfers[0]!;
    assert.equal(topUp.kind, "gas_top_up");
    return { node, adapter, gasWallet, deposit, saved, request, topUp };
  }

  it("never rebuilds a top-up that landed but whose receipt is not readable yet; then moves on to the transfers", async () => {
    const { node, adapter, saved, request, topUp } = await tokenSetup();
    node.mineAll({ receiptVisible: false, txVisible: false });

    const raced = await adapter.payout(request());
    assert.equal(raced.status, "pending", show(raced));
    assert.equal(saved.length, 1, "no rebuilt top-up was saved");
    assert.equal(node.sent.filter((t) => t !== topUp.txid).length, 0, "no second top-up was sent");

    node.revealAll();
    const next = await adapter.payout(request());
    assert.equal(next.status, "pending", show(next));
    assert.equal(saved.length, 2, "the transfers phase was saved");
    assert.equal(saved[1]!.plan.transfers[0]!.txid, topUp.txid, "the same top-up");
    assert.equal(node.sent.length, 4, "then the two token transfers and the gas sweep were sent");

    node.mineAll();
    const paid = await adapter.payout(request());
    assert.equal(paid.status, "paid", show(paid));
  });

  it("waits while another gas wallet transaction took the top-up's nonce only recently", async () => {
    const { node, adapter, gasWallet, saved, request } = await tokenSetup();
    node.steal(gasWallet.address, 0);

    const result = await adapter.payout(request());
    assert.equal(result.status, "pending", show(result));
    assert.equal(saved.length, 1, "nothing rebuilt yet");
    assert.equal(node.sent.length, 1);
  });

  it("rebuilds the top-up, saved before it is sent, once its nonce went to another transaction long enough ago", async () => {
    const { node, adapter, gasWallet, saved, request, topUp } = await tokenSetup();
    node.steal(gasWallet.address, 0);
    node.advance(LOST_AFTER);

    const sentBefore = node.sent.length;
    const result = await adapter.payout(request());
    assert.equal(result.status, "pending", show(result));
    assert.equal(saved.length, 2);
    const rebuilt = saved[1]!.plan.transfers[0]!;
    assert.notEqual(rebuilt.txid, topUp.txid);
    assert.equal(rebuilt.amount, topUp.amount);
    assert.deepEqual(node.sent.slice(sentBefore), [rebuilt.txid]);
  });
});
