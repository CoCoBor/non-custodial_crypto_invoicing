import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Wallet } from "ethers";

import type {
  AfterPayoutRequest,
  AfterPayoutResult,
  ChainAdapter,
  PayoutCheckpoint,
  PayoutRequest,
  PayoutResult,
} from "../../../src/chains/adapter.js";
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
   * The adapter's work after a proven payout (the gas sweep), from the
   * payout's last checkpoint; each save is kept and handed to the next call.
   */
  function afterPayoutOf(d: { deposit: { address: string; key: PayoutRequest["depositKey"] }; saved: PayoutCheckpoint[] }, saveState?: (next: string) => Promise<boolean>) {
    const states: string[] = [];
    const request = (): AfterPayoutRequest => ({
      depositAddress: d.deposit.address,
      depositKey: d.deposit.key,
      state: states.at(-1) ?? d.saved.at(-1)!.state,
      saveState:
        saveState ??
        (async (next) => {
          states.push(next);
          return true;
        }),
    });
    return { states, request };
  }

  /** Calls afterPayout until it is done. */
  async function sweepUntilDone(request: () => AfterPayoutRequest): Promise<AfterPayoutResult & { status: "done" }> {
    for (let round = 0; round < 40; round += 1) {
      const result = await adapter.afterPayout!(request());
      if (result.status === "done") return result;
      assert.equal(result.status, "pending", JSON.stringify(result));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail("sweep not done after 40 rounds");
  }

  /**
   * What the payout must have planned, from what the chain shows it really
   * used. The top-up covers each transfer's fee limit (its energy plus 10% at
   * the energy price) plus its bandwidth at the byte price. The merchant is
   * charged only the estimate (fix ticket F): the energy at its price, the
   * bandwidth the deposit's free allowance does not cover, and the gas
   * wallet's own cost (the activation for a new deposit, else its own
   * bandwidth). TRE's energy estimate is exact and its free bandwidth (5,000
   * bytes a day) covers both transfers, so the charge equals the real burn.
   * What is left at the deposit goes back to the gas wallet afterwards (gas_sweep).
   */
  async function expectedFromChain(
    paid: PayoutResult & { status: "paid" },
    received: bigint,
    feeRate: bigint,
    deposit: { trx: bigint; active: boolean } = { trx: 0n, active: false },
  ) {
    const energyFee = await node.chainParameter("getEnergyFee");
    const bytesFee = await node.chainParameter("getTransactionFee");
    const activationFee = (await node.chainParameter("getCreateAccountFee")) + (await node.chainParameter("getCreateNewAccountFeeInSystemContract"));
    let needed = 0n;
    let burned = 0n;
    for (const t of paid.transfers.filter((t) => t.kind !== "gas_top_up" && t.kind !== "gas_sweep")) {
      const cost = await node.costOf(t.txid);
      needed += ceilDivide(cost.energy * energyFee * 110n, 100n) + cost.netUsage * bytesFee;
      burned += cost.fee;
    }
    const topUp = needed > deposit.trx ? needed - deposit.trx : 0n;
    const topUpTx = paid.transfers.find((t) => t.kind === "gas_top_up");
    const ownCost = !deposit.active ? activationFee : topUpTx === undefined ? 0n : (await node.costOf(topUpTx.txid)).netUsage * bytesFee;
    const charged = topUp === 0n ? 0n : (burned > deposit.trx ? burned - deposit.trx : 0n) + ownCost;
    const reimbursed = ceilDivide(charged * 3n, 10n);
    const fee = ceilDivide(received * feeRate, 10n ** 8n);
    const sweep = topUp === 0n ? 0n : deposit.trx + topUp - burned;
    // What the code before fix ticket F charged: the whole top-up and the gas wallet's own cost.
    const oldCharge = topUp === 0n ? 0n : topUp + ownCost;
    return { topUp, burned, charged, oldCharge, reimbursed, sweep, fee, merchant: received - fee - reimbursed, platform: fee + reimbursed };
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

  it("pays at 5% to a new merchant address: the merchant charged the estimated burn only, paid once the USDT is solidified, the unused TRX swept back to the gas wallet afterwards", async (t) => {
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
    assert.ok(want.sweep > 0n);
    assert.equal(await node.trxBalance(d.deposit.address), want.sweep, "paid before any sweep: the unused TRX is still at the deposit");
    assert.equal(d.saved.length, 2, "top-up and transfers; nothing saved for a sweep");

    const swept = await sweepUntilDone(afterPayoutOf(d).request);
    assert.deepEqual(swept.transfers.map((t) => [t.kind, t.to, t.amount]), [["gas_sweep", gasWallet.address, want.sweep]]);
    assert.equal(await tokens(d.destination), want.merchant);
    assert.equal(await tokens(platform), want.platform);
    assert.equal(await tokens(d.deposit.address), 0n);
    assert.equal(d.saved.at(-1)!.plan.networkCost, want.reimbursed);
    assert.equal(d.saved.at(-1)!.plan.platformFee, want.fee);
    // The recorded gas_top_up is what really left the gas wallet: top-up plus the account creation it paid.
    const topUpCost = await node.costOf(paid.transfers[0]!.txid);
    assert.equal(paid.transfers[0]!.amount, want.topUp + topUpCost.fee);
    assert.equal(topUpCost.fee, (await node.chainParameter("getCreateAccountFee")) + (await node.chainParameter("getCreateNewAccountFeeInSystemContract")));
    // Unused energy headroom (and bandwidth the node gave for free) goes back to the gas wallet.
    assert.equal((await node.costOf(swept.transfers[0]!.txid)).fee, 0n, "the sweep's bandwidth was free");
    assert.equal(await node.trxBalance(d.deposit.address), 0n);
    assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount - want.sweep);
    const realSpend = topUpCost.fee + want.burned;
    assert.equal(want.charged, realSpend, "on TRE the estimate is exact");
    t.diagnostic(`tron payout, sun: old charge ${want.oldCharge}, new charge ${want.charged}, real spend ${realSpend}, swept back ${want.sweep}`);
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

  it("charges the fee only on the part that has not paid it yet (a refunded swap's money); the TRX is still reimbursed", async () => {
    await freshAdapter();
    const received = 200n * ONE_USDT;
    const exempt = 120n * ONE_USDT;
    const d = await fundedDeposit(received, { destinationKind: "refund_route", feeExempt: exempt });

    const paid = await payUntilPaid(d.request);
    const want = await expectedFromChain(paid, received - exempt, FIVE_PERCENT);

    assert.equal(want.fee, 4n * ONE_USDT);
    assert.equal(d.saved.at(-1)!.plan.platformFee, want.fee);
    assert.deepEqual(paid.transfers.map((t) => t.kind), ["gas_top_up", "refund_route", "platform_fee"]);
    assert.equal(await tokens(d.destination), received - want.fee - want.reimbursed);
    assert.equal(await tokens(platform), want.fee + want.reimbursed);
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
    await sweepUntilDone(afterPayoutOf(d).request);
    const merchantBefore = await tokens(d.destination);
    const leftover = await node.trxBalance(d.deposit.address);
    assert.equal(leftover, 0n, "the first payout's sweep took the deposit's TRX back");

    const late = 40n * ONE_USDT;
    await node.payToken(contract, d.deposit.address, late);
    const refund = newAddress();
    const route = await fundedDepositRoute(d, refund);
    const platformBefore = await tokens(platform);
    const gasBefore = await node.trxBalance(gasWallet.address);

    const paid = await payUntilPaid(route.request);
    const swept = await sweepUntilDone(afterPayoutOf({ deposit: d.deposit, saved: route.saved }).request);
    const want = await expectedFromChain(paid, late, FIVE_PERCENT, { trx: leftover, active: true });

    assert.deepEqual(paid.transfers.map((t) => t.kind), ["gas_top_up", "refund_route", "platform_fee"]);
    assert.deepEqual(swept.transfers.map((t) => [t.kind, t.amount]), [["gas_sweep", want.sweep]]);
    assert.equal(await tokens(refund), want.merchant);
    assert.equal((await tokens(platform)) - platformBefore, want.platform);
    assert.equal(await tokens(d.destination), merchantBefore, "the merchant was not paid again");
    assert.equal(await tokens(d.deposit.address), 0n);
    const topUpCost = await node.costOf(paid.transfers[0]!.txid);
    assert.equal(paid.transfers[0]!.amount, want.topUp + topUpCost.fee);
    assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount - want.sweep);
    assert.equal(await node.trxBalance(d.deposit.address), 0n);
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
    assert.equal(saved.length, 2);

    // A crash between paid and the sweep: the sweep starts from the payout's last checkpoint, on a later call.
    const after = afterPayoutOf({ deposit: d.deposit, saved });
    const swept = await sweepUntilDone(after.request);
    assert.equal(after.states.length, 1, "the sweep was saved before it was sent");
    assert.equal(new Set(counting.sent.slice(sentBefore)).size, 4, "plus the sweep: four distinct transactions");
    assert.deepEqual(await adapter.afterPayout!(after.request()), swept, "a call after done answers the same, sending nothing");
    assert.equal(new Set(counting.sent.slice(sentBefore)).size, 4);
    const want = await expectedFromChain(paid, 100n * ONE_USDT, FIVE_PERCENT);
    assert.equal(await tokens(d.destination), want.merchant);
    assert.equal(gasBefore - (await node.trxBalance(gasWallet.address)), paid.transfers[0]!.amount - want.sweep, "one top-up and one sweep only");
  });

  it("after a crash right after the sweep is saved, sends that sweep once and never a second one", async () => {
    await freshAdapter();
    const d = await fundedDeposit(100n * ONE_USDT);
    await payUntilPaid(d.request);
    const states: string[] = [];
    const crashing = afterPayoutOf(d, async (next) => {
      states.push(next);
      throw new Error("process killed after the save");
    });
    const sentBefore = counting.sent.length;
    const depositTrx = await node.trxBalance(d.deposit.address);

    await assert.rejects(adapter.afterPayout!(crashing.request()), /process killed/);
    assert.equal(states.length, 1, "the sweep's state was saved");
    assert.equal(counting.sent.length, sentBefore, "nothing was sent before the crash");
    assert.ok(depositTrx > 0n);

    const after = afterPayoutOf({ deposit: d.deposit, saved: [{ ...d.saved.at(-1)!, state: states[0]! }] });
    const swept = await sweepUntilDone(after.request);

    assert.equal(after.states.length, 0, "the saved sweep, not a new one");
    assert.equal(swept.transfers.length, 1);
    assert.equal(swept.transfers[0]!.amount, depositTrx);
    assert.equal(new Set(counting.sent.slice(sentBefore)).size, 1, "only the saved sweep was sent");
    assert.equal(await node.trxBalance(d.deposit.address), 0n);
  });

  it("gives up a sweep that can never land: done with nothing moved, never rebuilt, the TRX left at the deposit", async () => {
    await freshAdapter({ lostMarginMs: 60_000 });
    const d = await fundedDeposit(100n * ONE_USDT);
    await payUntilPaid(d.request);
    const states: string[] = [];
    const crashing = afterPayoutOf(d, async (next) => {
      states.push(next);
      throw new Error("process killed after the save");
    });
    await assert.rejects(adapter.afterPayout!(crashing.request()), /process killed/);
    const depositTrx = await node.trxBalance(d.deposit.address);
    const sentBefore = counting.sent.length;
    const after = afterPayoutOf({ deposit: d.deposit, saved: [{ ...d.saved.at(-1)!, state: states[0]! }] });

    // Never sent, and the solidified head is past its 2-minute life and the margin.
    counting.state.solidLag = true;
    counting.state.solidHeadAheadMs = 2 * 60_000 + 60_000 + 5_000;
    let result: AfterPayoutResult;
    try {
      result = await adapter.afterPayout!(after.request());
    } finally {
      counting.state.solidLag = false;
      counting.state.solidHeadAheadMs = 0;
    }

    assert.deepEqual(result, { status: "done", transfers: [] });
    assert.equal(after.states.length, 0, "no rebuilt sweep saved");
    assert.equal(counting.sent.length, sentBefore, "nothing sent");
    assert.equal(await node.trxBalance(d.deposit.address), depositTrx);
    const want = await expectedFromChain(await payUntilPaid(d.request), 100n * ONE_USDT, FIVE_PERCENT);
    assert.equal(await tokens(d.destination), want.merchant, "the merchant's payout stands");
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
    assert.deepEqual(paid.transfers.slice(1, 3).map((t) => t.txid), signedTransfers);
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
      // Proven: paid with the saved transfers, none rebuilt.
      assert.equal(result.status, "paid", show(result));
      assert.equal(d.saved.length, 2);
      const paid = result as PayoutResult & { status: "paid" };
      assert.deepEqual(paid.transfers.slice(1, 3).map((t) => t.txid), signedTransfers);
      const want = await expectedFromChain(paid, 100n * ONE_USDT, FIVE_PERCENT);
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
