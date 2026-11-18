import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Wallet } from "ethers";

import type { ChainAdapter, PayoutCheckpoint, PayoutRequest, PayoutResult } from "../../../src/chains/adapter.js";
import { createTronTokenAdapter } from "../../../src/chains/tron.js";
import { tronAddressFromEvm } from "../../../src/chains/tron-address.js";
import type { TronApi } from "../../../src/chains/tron-api.js";
import { ceilDivide } from "../../../src/money/format.js";
import { parseFeeRate, payerPaysAskedAmount } from "../../../src/money/payout-split.js";
import { sealSecret } from "../../../src/security/secret-envelope.js";
import { blockbookIndexShim, dockerUnavailable, startTron, type TronNode } from "./tre.js";

// Spec seam 3 for Tron: the real USDT (TRC-20) adapter pays out from a
// deposit on a throwaway TRE node (Docker). Never mainnet. The token is a
// test TRC-20 with 6 decimals, deployed at a new address (TRE can't place
// code at the real USDT address), and given to the adapter. Fees are burned
// TRX at the node's own prices (energy 100 sun, bandwidth 10 sun per byte,
// account creation 100,000 sun); every amount is read back from the node.

const skipReason = await dockerUnavailable();
if (skipReason !== undefined) console.warn(skipReason);

const FIVE_PERCENT = parseFeeRate("0.05")!;
const TRX_PRICE = "0.3"; // USDT per TRX
const ONE_USDT = 1_000_000n;

function show(result: PayoutResult): string {
  return JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

const newAddress = () => tronAddressFromEvm(Wallet.createRandom().address);

/**
 * Passes every call through, and counts the broadcasts. `solidLag` hides transactions from the solidified view, as before they are 19 blocks deep.
 * `hideInfoReads` hides them from that many lookups only, and `solidHeadAheadMs` moves the solidified head's time forward: together, a
 * load-balanced provider whose node answering the lookup is behind the one answering the head.
 */
function countingApi(inner: TronApi) {
  const sent: string[] = [];
  const state = { solidLag: false, hideInfoReads: 0, solidHeadAheadMs: 0 };
  const api: TronApi = {
    post: async (path, body) => {
      if (path === "/wallet/broadcasthex") sent.push((body as { transaction: string }).transaction);
      if (path === "/walletsolidity/gettransactioninfobyid") {
        if (state.solidLag) return {};
        if (state.hideInfoReads > 0) {
          state.hideInfoReads -= 1;
          return {};
        }
      }
      const reply = await inner.post(path, body);
      if (path === "/walletsolidity/getnowblock" && state.solidHeadAheadMs !== 0) {
        const block = structuredClone(reply) as { block_header: { raw_data: { timestamp: number } } };
        block.block_header.raw_data.timestamp += state.solidHeadAheadMs;
        return block;
      }
      return reply;
    },
  };
  return { api, sent, state };
}

describe("USDT on Tron (usdttrx) on a TRE node", { skip: skipReason }, () => {
  let node: TronNode;
  let counting: ReturnType<typeof countingApi>;
  let contract: string;
  let fakeContract: string;
  let platform: string;
  let gasWallet: { key: string; address: string };
  let adapter: ChainAdapter;
  let price: string | undefined;

  before(async () => {
    node = await startTron();
    counting = countingApi(node.api);
    contract = await node.deployToken(6);
    fakeContract = await node.deployToken(6);
  });

  after(async () => {
    await node?.stop();
  });

  const tokens = (owner: string) => node.tokenBalance(contract, owner);

  /** Fresh platform and gas wallets, so balances start known. */
  async function freshAdapter(options: { gasWalletKey?: boolean; platformHolds?: boolean; txLifetimeMs?: number; lostMarginMs?: number } = {}) {
    platform = newAddress();
    if (options.platformHolds) await node.payToken(contract, platform, 1n);
    const wallet = Wallet.createRandom();
    gasWallet = { key: wallet.privateKey, address: tronAddressFromEvm(wallet.address) };
    await node.sendTrx(node.funder, gasWallet.address, 300_000_000n);
    price = TRX_PRICE;
    adapter = createTronTokenAdapter({
      asset: "usdttrx",
      api: counting.api,
      index: blockbookIndexShim(node),
      platformAddress: platform,
      gasWalletKey: options.gasWalletKey === false ? undefined : sealSecret("tron-gas-wallet-key", gasWallet.key),
      trxPrice: async () => price,
      contract,
      ...(options.txLifetimeMs !== undefined && { txLifetimeMs: options.txLifetimeMs }),
      ...(options.lostMarginMs !== undefined && { lostMarginMs: options.lostMarginMs }),
    });
  }

  /** A deposit holding `amount`, and a request builder. */
  async function fundedDeposit(amount: bigint, fields: Partial<PayoutRequest> = {}) {
    const deposit = await adapter.newDeposit();
    await node.payToken(contract, deposit.address, amount);
    const saved: PayoutCheckpoint[] = [];
    const fixed: PayoutRequest = {
      depositAddress: deposit.address,
      depositKey: deposit.key,
      destination: newAddress(),
      destinationKind: "merchant_payout",
      receiveAsset: "usdttrx",
      feeRate: FIVE_PERCENT,
      minimumAmount: amount,
      checkpoint: undefined,
      saveCheckpoint: async (next) => {
        saved.push(next);
        return true;
      },
      ...fields,
    };
    const request = (checkpoint = saved.at(-1)): PayoutRequest => ({ ...fixed, checkpoint });
    return { deposit, saved, request, destination: fixed.destination };
  }

  /** Calls payout until it is paid (TRE solidifies each block at once). */
  async function payUntilPaid(request: () => PayoutRequest): Promise<PayoutResult & { status: "paid" }> {
    for (let round = 0; round < 40; round += 1) {
      const result = await adapter.payout(request());
      if (result.status === "paid") return result;
      assert.equal(result.status, "pending", show(result));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail("not paid after 40 rounds");
  }

  /**
   * What the payout must have planned, from what the chain shows it really
   * used: each transfer's fee limit is its energy plus 10% at the energy
   * price, plus its bandwidth at the byte price; the gas wallet's spend is
   * the top-up plus the activation fee (a new deposit) or its own bandwidth.
   */
  async function expectedFromChain(paid: PayoutResult & { status: "paid" }, received: bigint, feeRate: bigint, depositTrx = 0n) {
    const energyFee = await node.chainParameter("getEnergyFee");
    const bytesFee = await node.chainParameter("getTransactionFee");
    const activationFee = (await node.chainParameter("getCreateAccountFee")) + (await node.chainParameter("getCreateNewAccountFeeInSystemContract"));
    let needed = 0n;
    for (const t of paid.transfers.filter((t) => t.kind !== "gas_top_up")) {
      const cost = await node.costOf(t.txid);
      needed += ceilDivide(cost.energy * energyFee * 110n, 100n) + cost.netUsage * bytesFee;
    }
    const topUp = needed > depositTrx ? needed - depositTrx : 0n;
    // A deposit that already has an account costs the gas wallet only its own bandwidth.
    const topUpTx = paid.transfers.find((t) => t.kind === "gas_top_up");
    const ownBandwidth = depositTrx === 0n || topUpTx === undefined ? 0n : (await node.costOf(topUpTx.txid)).netUsage * bytesFee;
    const spend = topUp === 0n ? 0n : topUp + (depositTrx === 0n ? activationFee : ownBandwidth);
    const reimbursed = ceilDivide(spend * 3n, 10n);
    const fee = ceilDivide(received * feeRate, 10n ** 8n);
    return { topUp, spend, reimbursed, fee, merchant: received - fee - reimbursed, platform: fee + reimbursed };
  }

  // ---------- Payments ----------

  it("lists a USDT payment with its txid, amount, confirmations and block time, and not a fake token, TRX, or another address's transfer", async () => {
    await freshAdapter();
    const deposit = await adapter.newDeposit();
    const txid = await node.payToken(contract, deposit.address, 7n * ONE_USDT);
    await node.payToken(fakeContract, deposit.address, 1_000n * ONE_USDT);
    await node.sendTrx(node.funder, deposit.address, 1_000_000n);
    await node.payToken(contract, newAddress(), 5n);
    await node.tick();

    const payments = await adapter.getPayments(deposit.address);

    assert.equal(payments?.length, 1, JSON.stringify(payments, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.equal(payments![0]!.txid, txid);
    assert.equal(payments![0]!.amount, 7n * ONE_USDT);
    const info = await node.landed(txid);
    assert.equal(payments![0]!.confirmations, Number((await node.head()).number) - info.blockNumber + 1);
    assert.ok(payments![0]!.confirmations >= 2);
    assert.equal(payments![0]!.seenAt, info.blockTimeStamp);
  });

  it("answers undefined, not [], when the index misses a payment the balance shows", async () => {
    await freshAdapter();
    const deposit = await adapter.newDeposit();
    await node.payToken(contract, deposit.address, 3n * ONE_USDT);
    const blind = createTronTokenAdapter({
      asset: "usdttrx",
      api: node.api,
      index: { transferTxids: async () => [] },
      platformAddress: platform,
      gasWalletKey: undefined,
      trxPrice: async () => price,
      contract,
    });

    assert.equal(await blind.getPayments(deposit.address), undefined);
    assert.deepEqual(await blind.getPayments(newAddress()), []);
  });

  // ---------- Payouts ----------

  it("pays at 5% to a new merchant address: activation and both transfers' TRX topped up, exact USDT shares, the gas reimbursed in USDT", async () => {
    await freshAdapter();
    const received = 1_000n * ONE_USDT;
    const d = await fundedDeposit(received);
    const gasBefore = await node.trxBalance(gasWallet.address);
    assert.equal(await node.isActive(d.deposit.address), false, "receiving a TRC-20 token does not create the deposit's account");

    const paid = await payUntilPaid(d.request);
    const want = await expectedFromChain(paid, received, FIVE_PERCENT);

    assert.deepEqual(
      paid.transfers.map((t) => [t.kind, t.to, t.kind === "gas_top_up" ? "sun" : t.amount]),
      [
        ["gas_top_up", d.deposit.address, "sun"],
        ["merchant_payout", d.destination, want.merchant],
        ["platform_fee", platform, want.platform],
      ],
    );
    assert.equal(await tokens(d.destination), want.merchant);
    assert.equal(await tokens(platform), want.platform);
    assert.equal(await tokens(d.deposit.address), 0n);
    assert.equal(d.saved.at(-1)!.plan.networkCost, want.reimbursed);
    assert.equal(d.saved.at(-1)!.plan.platformFee, want.fee);
    // The recorded gas_top_up is what really left the gas wallet: top-up plus the account creation it paid.
    const topUpCost = await node.costOf(paid.transfers[0]!.txid);
    assert.equal(paid.transfers[0]!.amount, want.topUp + topUpCost.fee);
    assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount);
    assert.equal(topUpCost.fee, (await node.chainParameter("getCreateAccountFee")) + (await node.chainParameter("getCreateNewAccountFeeInSystemContract")));
    // Unused energy headroom (and bandwidth the node gave for free) stays at the deposit as TRX.
    const burned = (await node.costOf(paid.transfers[1]!.txid)).fee + (await node.costOf(paid.transfers[2]!.txid)).fee;
    assert.equal(await node.trxBalance(d.deposit.address), want.topUp - burned);
  });

  it("pays at 0%: the platform transfer carries only the reimbursement", async () => {
    await freshAdapter();
    const received = 200n * ONE_USDT;
    const d = await fundedDeposit(received, { feeRate: 0n });

    const paid = await payUntilPaid(d.request);
    const want = await expectedFromChain(paid, received, 0n);

    assert.equal(want.fee, 0n);
    assert.deepEqual(paid.transfers.map((t) => t.kind), ["gas_top_up", "merchant_payout", "platform_fee"]);
    assert.equal(await tokens(d.destination), received - want.reimbursed);
    assert.equal(await tokens(platform), want.reimbursed);
  });

  it("charges less when the merchant address already holds USDT (no new storage slot)", async () => {
    await freshAdapter({ platformHolds: true });
    const holder = newAddress();
    await node.payToken(contract, holder, 1n);
    const fresh = await fundedDeposit(100n * ONE_USDT);
    const existing = await fundedDeposit(100n * ONE_USDT, { destination: holder });

    const paidFresh = await payUntilPaid(fresh.request);
    const paidExisting = await payUntilPaid(existing.request);

    const energy = async (p: typeof paidFresh) => (await node.costOf(p.transfers[1]!.txid)).energy;
    assert.ok((await energy(paidExisting)) < (await energy(paidFresh)), "a transfer to a holder uses less energy");
    assert.ok(existing.saved.at(-1)!.plan.networkCost < fresh.saved.at(-1)!.plan.networkCost);
    const want = await expectedFromChain(paidExisting, 100n * ONE_USDT, FIVE_PERCENT);
    assert.equal(await tokens(holder), 1n + want.merchant);
  });

  it("routes late money after the merchant payout to the refund address, topping up only the TRX the deposit lacks", async () => {
    await freshAdapter();
    const d = await fundedDeposit(100n * ONE_USDT);
    await payUntilPaid(d.request);
    const merchantBefore = await tokens(d.destination);
    const leftover = await node.trxBalance(d.deposit.address);
    assert.ok(leftover > 0n);

    const late = 40n * ONE_USDT;
    await node.payToken(contract, d.deposit.address, late);
    const refund = newAddress();
    const route = await fundedDepositRoute(d, refund);
    const platformBefore = await tokens(platform);
    const gasBefore = await node.trxBalance(gasWallet.address);

    const paid = await payUntilPaid(route.request);
    const want = await expectedFromChain(paid, late, FIVE_PERCENT, leftover);

    assert.deepEqual(paid.transfers.map((t) => t.kind), ["gas_top_up", "refund_route", "platform_fee"]);
    assert.equal(await tokens(refund), want.merchant);
    assert.equal((await tokens(platform)) - platformBefore, want.platform);
    assert.equal(await tokens(d.destination), merchantBefore, "the merchant was not paid again");
    assert.equal(await tokens(d.deposit.address), 0n);
    const topUpCost = await node.costOf(paid.transfers[0]!.txid);
    assert.equal(paid.transfers[0]!.amount, want.topUp + topUpCost.fee);
    assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount);
  });

  /** A refund route from the same deposit: its own checkpoints, minimumAmount 1. */
  async function fundedDepositRoute(d: Awaited<ReturnType<typeof fundedDeposit>>, refund: string) {
    const saved: PayoutCheckpoint[] = [];
    const fixed: PayoutRequest = {
      ...d.request(undefined),
      destination: refund,
      destinationKind: "refund_route",
      minimumAmount: 1n,
      saveCheckpoint: async (next) => {
        saved.push(next);
        return true;
      },
    };
    return { saved, request: (): PayoutRequest => ({ ...fixed, checkpoint: saved.at(-1) }) };
  }

  it("after a crash after each checkpoint, sends the top-up and each transfer once, and nothing after paid", async () => {
    await freshAdapter();
    const saved: PayoutCheckpoint[] = [];
    let crash = true;
    const d = await fundedDeposit(100n * ONE_USDT, {
      saveCheckpoint: async (next) => {
        saved.push(next);
        if (crash) throw new Error("process killed after the save");
        return true;
      },
    });
    const sentBefore = counting.sent.length;
    const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });
    const gasBefore = await node.trxBalance(gasWallet.address);

    // Checkpoint 1: the top-up is signed, nothing sent.
    await assert.rejects(adapter.payout(d.request(undefined)), /process killed/);
    assert.equal(saved.length, 1);
    assert.equal(counting.sent.length, sentBefore, "nothing was broadcast before the first crash");
    assert.equal(await node.trxBalance(gasWallet.address), gasBefore);

    // The re-run sends the saved top-up.
    assert.equal((await adapter.payout(again())).status, "pending");
    assert.equal(counting.sent.length - sentBefore, 1);
    await node.landed(saved[0]!.plan.transfers[0]!.txid);

    // Checkpoint 2 (top-up landed): crash before the transfers go out.
    await assert.rejects(adapter.payout(again()), /process killed/);
    assert.equal(saved.length, 2);
    assert.equal(counting.sent.length - sentBefore, 1, "nothing was broadcast before the second crash");
    assert.equal(await tokens(d.deposit.address), 100n * ONE_USDT);

    crash = false;
    const paid = await payUntilPaid(again);
    const sentAtPaid = counting.sent.length;
    const paidAgain = await adapter.payout(again());

    assert.deepEqual(paidAgain, paid);
    assert.equal(counting.sent.length, sentAtPaid, "nothing sent after paid");
    assert.equal(new Set(counting.sent.slice(sentBefore)).size, 3, "top-up, merchant and platform transfers: three distinct transactions");
    const want = await expectedFromChain(paid, 100n * ONE_USDT, FIVE_PERCENT);
    assert.equal(await tokens(d.destination), want.merchant);
    assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount, "one top-up only");
  });

  it("while sent transfers wait to be solidified, re-sends the same signed bytes and never a second version", async () => {
    await freshAdapter();
    const d = await fundedDeposit(100n * ONE_USDT);
    assert.equal((await adapter.payout(d.request())).status, "pending");
    await node.landed(d.saved[0]!.plan.transfers[0]!.txid);
    assert.equal((await adapter.payout(d.request())).status, "pending");
    assert.equal(d.saved.length, 2, "the transfers are signed, saved and sent");
    const signedTransfers = d.saved[1]!.plan.transfers.slice(1).map((t) => t.txid);

    counting.state.solidLag = true;
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await adapter.payout(d.request())).status, "pending");
    } finally {
      counting.state.solidLag = false;
    }
    const paid = await payUntilPaid(d.request);

    assert.equal(d.saved.length, 2, "nothing rebuilt");
    assert.deepEqual(paid.transfers.slice(1).map((t) => t.txid), signedTransfers);
    const want = await expectedFromChain(paid, 100n * ONE_USDT, FIVE_PERCENT);
    assert.equal(await tokens(d.destination), want.merchant);
  });

  describe("a saved transaction a lagging node can't find yet, while the solidified head is past its expiration", () => {
    const LIFETIME_MS = 10 * 60_000;
    const MARGIN_MS = 60_000;

    it("waits, and never rebuilds the top-up, within the margin past its expiration", async () => {
      await freshAdapter({ txLifetimeMs: LIFETIME_MS, lostMarginMs: MARGIN_MS });
      const d = await fundedDeposit(100n * ONE_USDT);
      const gasBefore = await node.trxBalance(gasWallet.address);
      assert.equal((await adapter.payout(d.request())).status, "pending");
      const topUp = d.saved[0]!.plan.transfers[0]!.txid;
      await node.landed(topUp);
      const sentBefore = counting.sent.length;

      counting.state.solidLag = true;
      counting.state.solidHeadAheadMs = LIFETIME_MS + 5_000;
      try {
        const raced = await adapter.payout(d.request());
        assert.equal(raced.status, "pending", show(raced));
      } finally {
        counting.state.solidLag = false;
        counting.state.solidHeadAheadMs = 0;
      }
      assert.equal(d.saved.length, 1, "no rebuilt top-up saved");
      assert.equal(counting.sent.length, sentBefore, "nothing sent");

      const paid = await payUntilPaid(d.request);
      assert.equal(paid.transfers[0]!.txid, topUp);
      assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount, "one top-up only");
    });

    it("past the margin, looks the top-up up again and follows it instead of rebuilding", async () => {
      await freshAdapter({ txLifetimeMs: LIFETIME_MS, lostMarginMs: MARGIN_MS });
      const d = await fundedDeposit(100n * ONE_USDT);
      const gasBefore = await node.trxBalance(gasWallet.address);
      assert.equal((await adapter.payout(d.request())).status, "pending");
      const topUp = d.saved[0]!.plan.transfers[0]!.txid;
      await node.landed(topUp);

      counting.state.hideInfoReads = 1;
      counting.state.solidHeadAheadMs = LIFETIME_MS + MARGIN_MS + 5_000;
      try {
        assert.equal((await adapter.payout(d.request())).status, "pending");
      } finally {
        counting.state.hideInfoReads = 0;
        counting.state.solidHeadAheadMs = 0;
      }
      assert.equal(d.saved.length, 2, "the transfers were saved, not a rebuilt top-up");
      assert.equal(d.saved[1]!.plan.transfers[0]!.txid, topUp);

      const paid = await payUntilPaid(d.request);
      assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount, "one top-up only");
    });

    it("past the margin, looks the transfers up again and proves them instead of rebuilding", async () => {
      await freshAdapter({ txLifetimeMs: LIFETIME_MS, lostMarginMs: MARGIN_MS });
      const d = await fundedDeposit(100n * ONE_USDT);
      assert.equal((await adapter.payout(d.request())).status, "pending");
      await node.landed(d.saved[0]!.plan.transfers[0]!.txid);
      assert.equal((await adapter.payout(d.request())).status, "pending");
      assert.equal(d.saved.length, 2, "the transfers are signed, saved and sent");
      const signedTransfers = d.saved[1]!.plan.transfers.slice(1).map((t) => t.txid);
      for (const txid of signedTransfers) await node.landed(txid);

      counting.state.hideInfoReads = 1;
      counting.state.solidHeadAheadMs = LIFETIME_MS + MARGIN_MS + 5_000;
      let result: PayoutResult;
      try {
        result = await adapter.payout(d.request());
      } finally {
        counting.state.hideInfoReads = 0;
        counting.state.solidHeadAheadMs = 0;
      }
      assert.equal(result.status, "paid", show(result));
      assert.equal(d.saved.length, 2, "nothing rebuilt");
      assert.deepEqual(result.status === "paid" && result.transfers.slice(1).map((t) => t.txid), signedTransfers);
      const want = await expectedFromChain(result as PayoutResult & { status: "paid" }, 100n * ONE_USDT, FIVE_PERCENT);
      assert.equal(await tokens(d.destination), want.merchant);
    });
  });

  it("sends nothing when another run saved first", async () => {
    await freshAdapter();
    const d = await fundedDeposit(100n * ONE_USDT, { saveCheckpoint: async () => false });
    const sentBefore = counting.sent.length;

    const result = await adapter.payout(d.request());

    assert.equal(result.status, "pending", show(result));
    assert.equal(counting.sent.length, sentBefore);
  });

  it("rebuilds an expired top-up and expired transfers only once the solidified chain is past their expiration, saving first", async () => {
    await freshAdapter({ txLifetimeMs: 1_500, lostMarginMs: 500 });
    const saved: PayoutCheckpoint[] = [];
    let crash = true;
    const d = await fundedDeposit(100n * ONE_USDT, {
      saveCheckpoint: async (next) => {
        saved.push(next);
        if (crash) throw new Error("process killed after the save");
        return true;
      },
    });
    const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });
    const gasBefore = await node.trxBalance(gasWallet.address);

    await assert.rejects(adapter.payout(d.request(undefined)), /process killed/);
    const expiredTopUp = saved[0]!.plan.transfers[0]!.txid;
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    await node.tick();

    // The re-run sees it expired: it saves a rebuilt top-up first (and "crashes" before sending it).
    await assert.rejects(adapter.payout(again()), /process killed/);
    assert.equal(saved.length, 2);
    const rebuiltTopUp = saved[1]!.plan.transfers[0]!.txid;
    assert.notEqual(rebuiltTopUp, expiredTopUp);

    crash = false;
    assert.equal((await adapter.payout(again())).status, "pending");
    await node.landed(rebuiltTopUp);

    // Transfers: signed and saved, then a crash before they are sent; they expire too.
    crash = true;
    await assert.rejects(adapter.payout(again()), /process killed/);
    const expiredMerchant = saved.at(-1)!.plan.transfers[1]!.txid;
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    await node.tick();
    crash = false;

    const paid = await payUntilPaid(again);

    assert.notEqual(paid.transfers[1]!.txid, expiredMerchant);
    assert.deepEqual(await node.post("/walletsolidity/gettransactioninfobyid", { value: expiredTopUp }), {});
    assert.deepEqual(await node.post("/walletsolidity/gettransactioninfobyid", { value: expiredMerchant }), {});
    const want = await expectedFromChain(paid, 100n * ONE_USDT, FIVE_PERCENT);
    assert.equal(await tokens(d.destination), want.merchant);
    assert.equal(await tokens(platform), want.platform);
    assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount, "one top-up only");
  });

  it("says too small to forward, and sends nothing, when the network cost would eat the deposit", async () => {
    await freshAdapter();
    const d = await fundedDeposit(ONE_USDT);
    const gasBefore = await node.trxBalance(gasWallet.address);
    const sentBefore = counting.sent.length;

    const result = await adapter.payout(d.request());

    assert.equal(result.status, "too_small", show(result));
    assert.equal(d.saved.length, 0);
    assert.equal(counting.sent.length, sentBefore);
    assert.equal(await node.trxBalance(gasWallet.address), gasBefore);
    assert.equal(await tokens(d.deposit.address), ONE_USDT);
  });

  it("pays a payer-pays invoice paid exactly: the merchant receives exactly the invoice amount", async () => {
    await freshAdapter({ platformHolds: true });
    const holder = newAddress();
    await node.payToken(contract, holder, 1n);
    const invoiceAmount = 250n * ONE_USDT;
    const estimate = await adapter.estimateNetworkCost();
    assert.ok(typeof estimate === "bigint" && estimate > 0n);
    const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost: estimate, feeRate: FIVE_PERCENT });
    const d = await fundedDeposit(asked, { destination: holder });

    const paid = await payUntilPaid(d.request);

    assert.equal(d.saved.at(-1)!.plan.networkCost, estimate, "the payout's real reimbursement equals the estimate");
    assert.equal((await tokens(holder)) - 1n, invoiceAmount);
    assert.equal(paid.transfers[1]!.amount, invoiceAmount);
  });

  it("waits with a review note, sending nothing, when the gas wallet key is missing; payments are still listed", async () => {
    await freshAdapter({ gasWalletKey: false });
    const d = await fundedDeposit(10n * ONE_USDT);
    const sentBefore = counting.sent.length;

    const result = await adapter.payout(d.request());

    assert.equal(result.status, "pending", show(result));
    assert.match((result as { review?: string }).review ?? "", /gas wallet key is not configured/);
    assert.match((result as { review?: string }).review ?? "", new RegExp(d.deposit.address));
    assert.equal(d.saved.length, 0);
    assert.equal(counting.sent.length, sentBefore);
    assert.equal((await adapter.getPayments(d.deposit.address))?.length, 1, "payments are still detected");
  });

  it("waits, sending nothing, when no TRX price converts the network cost", async () => {
    await freshAdapter({ platformHolds: true });
    price = undefined;
    const d = await fundedDeposit(10n * ONE_USDT);
    const sentBefore = counting.sent.length;

    const result = await adapter.payout(d.request());

    assert.equal(result.status, "pending", show(result));
    assert.equal(d.saved.length, 0);
    assert.equal(counting.sent.length, sentBefore);
    assert.equal(await adapter.estimateNetworkCost(), undefined);
  });

  it("stops, sending nothing, when the destination is the token contract or not a Tron address", async () => {
    await freshAdapter();
    for (const destination of [contract, "0x000000000000000000000000000000000000dEaD"]) {
      const d = await fundedDeposit(10n * ONE_USDT, { destination });
      const result = await adapter.payout(d.request());
      assert.equal(result.status, "failed", show(result));
      assert.match((result as { message: string }).message, new RegExp(d.deposit.address));
      assert.equal(d.saved.length, 0);
    }
  });
});
