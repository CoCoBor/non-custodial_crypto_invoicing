import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { DepositUnavailableError, type ChainAdapter, type PayoutCheckpoint, type PayoutRequest, type PayoutResult } from "../../../src/chains/adapter.js";
import { createMoneroRpc, type MoneroRpc } from "../../../src/chains/monero-rpc.js";
import { createXmrAdapter } from "../../../src/chains/xmr.js";
import { payerPaysAskedAmount, splitPayout } from "../../../src/money/payout-split.js";
import { findMoneroBinDir, moneroMissing, must, PLATFORM_LOGIN, startMoneroRegtest, type MoneroRegtest } from "./regtest.js";

// The XMR adapter on a real Monero regtest chain (monerod + monero-wallet-rpc
// v0.18.5.4). One chain for the whole file; every amount is in piconero.
// Receivers are separate wallets, so what arrives is read from the wallet
// that owns the address, not only from the payout's own proof.

const XMR = 1_000_000_000_000n;
const FIVE_PERCENT = 5_000_000n;
const UNLOCK_BLOCKS = 10;

const skip = moneroMissing();
if (skip) console.log(skip);

const show = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));

/** A watcher stand-in: keeps the last saved checkpoint, like the invoice's tx.raw. */
function checkpointStore(accept = true) {
  const store: { checkpoint: PayoutCheckpoint | undefined; saves: number } = { checkpoint: undefined, saves: 0 };
  const save = async (next: PayoutCheckpoint) => {
    store.saves += 1;
    if (!accept) return false;
    store.checkpoint = next;
    return true;
  };
  return { store, save };
}

/** Counts the platform wallet calls that build or send, and can drop a relay (a crash right after the save). */
function watchedWallet(inner: MoneroRpc) {
  const counts = { transfer: 0, relay_tx: 0 };
  let dropRelays = 0;
  const rpc: MoneroRpc = {
    async call(method, params) {
      if (method === "transfer") counts.transfer += 1;
      if (method === "relay_tx") {
        if (dropRelays > 0) {
          dropRelays -= 1;
          throw new Error("crashed before relay_tx");
        }
        counts.relay_tx += 1;
      }
      return await inner.call(method, params);
    },
  };
  return { rpc, counts, dropNextRelay: () => (dropRelays += 1) };
}

async function unlockedAt(wallet: MoneroRpc, index = 0): Promise<bigint> {
  const balance = await must<{ per_subaddress?: { address_index: number; balance: number | bigint; unlocked_balance: number | bigint }[] }>(
    wallet,
    "get_balance",
    { account_index: 0, address_indices: [index] },
  );
  return BigInt(balance.per_subaddress?.find((entry) => entry.address_index === index)?.balance ?? 0);
}

describe("XMR adapter with no platform wallet configured", () => {
  const adapter = createXmrAdapter({ wallet: undefined, daemon: undefined, platformAddress: undefined });

  it("refuses to make a deposit, with an error invoice creation can answer", async () => {
    await assert.rejects(adapter.newDeposit(), (error) => error instanceof DepositUnavailableError && error.asset === "xmr");
  });

  it("can't list payments or estimate, and a payout waits with a note", async () => {
    assert.equal(await adapter.getPayments("888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H"), undefined);
    assert.equal(await adapter.estimateNetworkCost(), "unsupported");
    const result = await adapter.payout({
      depositAddress: "888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H",
      depositKey: { kind: "subaddress", index: 3 },
      destination: "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A",
      destinationKind: "merchant_payout",
      receiveAsset: "xmr",
      feeRate: FIVE_PERCENT,
      minimumAmount: 1n,
      checkpoint: undefined,
      saveCheckpoint: async () => true,
    });
    assert.equal(result.status, "pending");
    assert.match((result as { review?: string }).review ?? "", /MONERO_WALLET_RPC_URL/);
  });
});

describe("XMR adapter on a regtest chain", { skip }, () => {
  let chain: MoneroRegtest;
  let platformWallet: ReturnType<typeof watchedWallet>;
  let adapter: ChainAdapter;
  let merchantSubaddress: { address: string; index: number };

  const request = (
    deposit: { address: string; key: { kind: "subaddress"; index: number } },
    overrides: Partial<PayoutRequest> & { save: (next: PayoutCheckpoint) => Promise<boolean>; checkpoint: PayoutCheckpoint | undefined },
  ): PayoutRequest => ({
    depositAddress: deposit.address,
    depositKey: deposit.key,
    destination: merchantSubaddress.address,
    destinationKind: "merchant_payout",
    receiveAsset: "xmr",
    feeRate: FIVE_PERCENT,
    minimumAmount: 1n,
    saveCheckpoint: overrides.save,
    ...overrides,
  });

  /** A funded deposit with unlocked outputs: paid `amounts` (one transaction each), mined and unlocked. */
  async function fundedDeposit(amounts: bigint[]) {
    const deposit = (await adapter.newDeposit()) as { address: string; key: { kind: "subaddress"; index: number } };
    for (const amount of amounts) await chain.pay([{ address: deposit.address, amount }]);
    await chain.mine(UNLOCK_BLOCKS + 1);
    return deposit;
  }

  /** Runs payout passes the way the watcher does (saving, then following the checkpoint) until it settles. */
  async function payOut(deposit: Awaited<ReturnType<typeof fundedDeposit>>, overrides: Partial<PayoutRequest> = {}) {
    const { store, save } = checkpointStore();
    let result: PayoutResult = { status: "pending", reason: "not run" };
    for (let pass = 0; pass < 4 && result.status === "pending"; pass++) {
      result = await adapter.payout(request(deposit, { save, checkpoint: store.checkpoint, ...overrides }));
      if (result.status === "pending") await chain.mine(1);
    }
    return { result, store };
  }

  before(async () => {
    chain = await startMoneroRegtest(findMoneroBinDir()!);
    // Coinbase outputs unlock after 60 blocks, and a ring of 16 needs that
    // many outputs on chain.
    await chain.mine(120);
    platformWallet = watchedWallet(chain.wallets.platform);
    adapter = createXmrAdapter({ wallet: platformWallet.rpc, daemon: chain.daemon, platformAddress: chain.addresses.fee });
    const created = await must<{ address: string; address_index: number }>(chain.wallets.merchant, "create_address", { account_index: 0 });
    merchantSubaddress = { address: created.address, index: created.address_index };
  });

  after(async () => {
    await chain?.stop();
  });

  it("makes a new subaddress of the platform wallet for each invoice, with no key to store", async () => {
    const first = await adapter.newDeposit();
    const second = await adapter.newDeposit();

    assert.equal(first.key.kind, "subaddress");
    assert.equal(second.key.kind, "subaddress");
    assert.ok(first.address.startsWith("8") && second.address.startsWith("8"));
    assert.notEqual(first.address, second.address);
    assert.equal((second.key as { index: number }).index, (first.key as { index: number }).index + 1);
    assert.equal(adapter.isValidAddress(first.address), true);
    assert.deepEqual(await adapter.getPayments(first.address), []);
  });

  it("lists a payment from the mempool on, per subaddress and per transaction, with its confirmations and time", async () => {
    const a = await adapter.newDeposit();
    const b = await adapter.newDeposit();
    const one = await chain.pay([{ address: a.address, amount: 2n * XMR }]);
    const both = await chain.pay([
      { address: a.address, amount: XMR / 2n },
      { address: b.address, amount: XMR / 4n },
    ]);

    const inPool = await adapter.getPayments(a.address);
    assert.deepEqual(
      inPool?.map(({ txid, amount, confirmations }) => ({ txid, amount, confirmations })).sort((x, y) => x.txid.localeCompare(y.txid)),
      [
        { txid: one, amount: 2n * XMR, confirmations: 0 },
        { txid: both, amount: XMR / 2n, confirmations: 0 },
      ].sort((x, y) => x.txid.localeCompare(y.txid)),
    );
    assert.ok(inPool!.every((payment) => typeof payment.seenAt === "number" && Math.abs(payment.seenAt - Date.now()) < 10 * 60_000));

    await chain.mine(2);
    const mined = await adapter.getPayments(a.address);
    assert.deepEqual(mined?.map((payment) => payment.confirmations), [2, 2]);
    assert.deepEqual(
      (await adapter.getPayments(b.address))?.map(({ txid, amount }) => ({ txid, amount })),
      [{ txid: both, amount: XMR / 4n }],
    );
  });

  it("answers undefined, not [], for an address the platform wallet does not hold", async () => {
    assert.equal(await adapter.getPayments(chain.addresses.merchant), undefined);
  });

  it("answers undefined when the wallet refuses the login", async () => {
    const locked = createXmrAdapter({
      wallet: createMoneroRpc({ url: chain.platformUrl, login: { ...PLATFORM_LOGIN, password: "wrong" } }),
      daemon: chain.daemon,
      platformAddress: chain.addresses.fee,
    });
    const deposit = await adapter.newDeposit();
    assert.equal(await locked.getPayments(deposit.address), undefined);
  });

  it("waits while the deposit's outputs are still locked", async () => {
    const deposit = await adapter.newDeposit();
    await chain.pay([{ address: deposit.address, amount: XMR }]);
    await chain.mine(1);
    const { store, save } = checkpointStore();

    const result = await adapter.payout(request(deposit as never, { save, checkpoint: undefined }));

    assert.equal(result.status, "pending");
    assert.match((result as { reason: string }).reason, /blocks for the deposit's outputs to unlock/);
    assert.equal(store.saves, 0);
  });

  it("pays out at 5%: the network fee comes off the merchant, and both receivers get exactly the F1 shares", async () => {
    const deposit = await fundedDeposit([XMR, XMR / 2n]);
    const merchantBefore = await unlockedAt(chain.wallets.merchant, merchantSubaddress.index);
    const feeBefore = await unlockedAt(chain.wallets.fee);

    const { result, store } = await payOut(deposit);

    assert.equal(result.status, "paid", show(result));
    const plan = store.checkpoint!.plan;
    const split = splitPayout({ received: 3n * XMR / 2n, networkCost: plan.networkCost, feeRate: FIVE_PERCENT })!;
    assert.equal(plan.platformFee, 75_000_000_000n);
    assert.ok(plan.networkCost > 0n);
    const paid = result as Extract<PayoutResult, { status: "paid" }>;
    assert.deepEqual(
      paid.transfers.map(({ kind, to, amount }) => ({ kind, to, amount })),
      [
        { kind: "merchant_payout", to: merchantSubaddress.address, amount: split.merchantAmount },
        { kind: "platform_fee", to: chain.addresses.fee, amount: 75_000_000_000n },
      ],
    );
    assert.equal(paid.transfers[0]!.txid, paid.transfers[1]!.txid);
    assert.equal(split.merchantAmount + plan.platformFee + plan.networkCost, 3n * XMR / 2n);

    assert.equal(await unlockedAt(chain.wallets.merchant, merchantSubaddress.index), merchantBefore + split.merchantAmount);
    assert.equal(await unlockedAt(chain.wallets.fee), feeBefore + 75_000_000_000n);
    assert.equal(await unlockedAt(chain.wallets.platform, deposit.key.index), 0n);

    const fee = await must<{ transfer: { fee: number } }>(chain.wallets.platform, "get_transfer_by_txid", { txid: paid.transfers[0]!.txid });
    assert.equal(BigInt(fee.transfer.fee), plan.networkCost);
  });

  it("pays out at 0% with a single destination and no platform transfer", async () => {
    const deposit = await fundedDeposit([XMR]);
    const feeBefore = await unlockedAt(chain.wallets.fee);

    const { result, store } = await payOut(deposit, { feeRate: 0n, destination: chain.addresses.merchant });

    assert.equal(result.status, "paid", show(result));
    const paid = result as Extract<PayoutResult, { status: "paid" }>;
    assert.equal(paid.transfers.length, 1);
    assert.equal(paid.transfers[0]!.amount, XMR - store.checkpoint!.plan.networkCost);
    assert.equal(store.checkpoint!.plan.platformFee, 0n);
    assert.equal(await unlockedAt(chain.wallets.fee), feeBefore);
  });

  it("never spends another invoice's outputs: two subaddresses funded at once, one paid out", async () => {
    const a = await adapter.newDeposit();
    const b = await adapter.newDeposit();
    await chain.pay([
      { address: a.address, amount: XMR },
      { address: b.address, amount: 3n * XMR },
    ]);
    await chain.pay([{ address: b.address, amount: XMR }]);
    await chain.mine(UNLOCK_BLOCKS + 1);
    const bOutputs = async () =>
      (await must<{ transfers?: { key_image: string; spent: boolean }[] }>(chain.wallets.platform, "incoming_transfers", {
        transfer_type: "all",
        account_index: 0,
        subaddr_indices: [(b.key as { index: number }).index],
      })).transfers ?? [];
    const before = await bOutputs();

    const { result } = await payOut(a as never);

    assert.equal(result.status, "paid", show(result));
    assert.equal(await unlockedAt(chain.wallets.platform, (a.key as { index: number }).index), 0n);
    assert.equal(await unlockedAt(chain.wallets.platform, (b.key as { index: number }).index), 4n * XMR);
    assert.deepEqual(await bOutputs(), before);
    assert.ok(before.length === 2 && before.every((output) => !output.spent));
  });

  it("routes late money from the same subaddress to the refund address, without paying the merchant again", async () => {
    const deposit = await fundedDeposit([XMR]);
    assert.equal((await payOut(deposit)).result.status, "paid");
    const merchantAfterPayout = await unlockedAt(chain.wallets.merchant, merchantSubaddress.index);
    await chain.pay([{ address: deposit.address, amount: XMR / 5n }]);
    await chain.mine(UNLOCK_BLOCKS + 1);
    const refundBefore = await unlockedAt(chain.wallets.refund);

    const { result, store } = await payOut(deposit, {
      destination: chain.addresses.refund,
      destinationKind: "refund_route",
      minimumAmount: 1n,
    });

    assert.equal(result.status, "paid", show(result));
    const plan = store.checkpoint!.plan;
    const split = splitPayout({ received: XMR / 5n, networkCost: plan.networkCost, feeRate: FIVE_PERCENT })!;
    const paid = result as Extract<PayoutResult, { status: "paid" }>;
    assert.deepEqual(paid.transfers.map(({ kind, amount }) => ({ kind, amount })), [
      { kind: "refund_route", amount: split.merchantAmount },
      { kind: "platform_fee", amount: split.platformFee },
    ]);
    assert.equal(await unlockedAt(chain.wallets.refund), refundBefore + split.merchantAmount);
    assert.equal(await unlockedAt(chain.wallets.merchant, merchantSubaddress.index), merchantAfterPayout);
  });

  it("after a crash between the save and the send, the re-run sends the saved transaction once and never builds another", async () => {
    const deposit = await fundedDeposit([XMR]);
    const { store, save } = checkpointStore();
    const counts = { ...platformWallet.counts };
    platformWallet.dropNextRelay();

    await assert.rejects(adapter.payout(request(deposit, { save, checkpoint: undefined })), /crashed before relay_tx/);
    const saved = store.checkpoint!;
    const txid = saved.plan.transfers[0]!.txid;
    const notSent = await must(chain.wallets.platform, "get_transfer_by_txid", { txid }).catch(() => "unknown");
    assert.equal(notSent, "unknown");

    const resent = await adapter.payout(request(deposit, { save, checkpoint: saved }));
    assert.equal(resent.status, "pending");
    const again = await adapter.payout(request(deposit, { save, checkpoint: saved }));
    assert.equal(again.status, "pending");
    await chain.mine(1);
    const paid = await adapter.payout(request(deposit, { save, checkpoint: saved }));
    const paidAgain = await adapter.payout(request(deposit, { save, checkpoint: saved }));

    assert.equal(paid.status, "paid", show(paid));
    assert.deepEqual(paidAgain, paid);
    assert.equal(platformWallet.counts.transfer - counts.transfer, 1, "built once");
    assert.equal(store.saves, 1);
    const sent = await must<{ out?: { txid: string }[] }>(chain.wallets.platform, "get_transfers", { out: true, account_index: 0, subaddr_indices: [deposit.key.index] });
    assert.deepEqual(sent.out?.map((transfer) => transfer.txid), [txid]);
  });

  it("sends nothing when another run saved first", async () => {
    const deposit = await fundedDeposit([XMR]);
    const { store, save } = checkpointStore(false);
    const relays = platformWallet.counts.relay_tx;

    const result = await adapter.payout(request(deposit, { save, checkpoint: undefined }));

    assert.equal(result.status, "pending");
    assert.equal(store.saves, 1);
    assert.equal(platformWallet.counts.relay_tx, relays);
    await chain.mine(1);
    assert.equal(await unlockedAt(chain.wallets.platform, deposit.key.index), XMR);
  });

  it("is too small to forward when the fee and the platform share use up the deposit: nothing saved or sent", async () => {
    const deposit = await fundedDeposit([1_000_000n]);
    const { store, save } = checkpointStore();

    const result = await adapter.payout(request(deposit, { save, checkpoint: undefined }));

    assert.equal(result.status, "too_small", show(result));
    assert.equal(store.saves, 0);
    assert.equal(await unlockedAt(chain.wallets.platform, deposit.key.index), 1_000_000n);
  });

  it("payer-pays: paying exactly the asked amount leaves the merchant exactly the invoice amount (subaddress destination, the widest)", async () => {
    const estimate = await adapter.estimateNetworkCost();
    assert.ok(typeof estimate === "bigint" && estimate > 0n);
    const invoiceAmount = 123_456_789_012n;
    const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost: estimate, feeRate: FIVE_PERCENT });
    const deposit = await fundedDeposit([asked]);
    const merchantBefore = await unlockedAt(chain.wallets.merchant, merchantSubaddress.index);

    const { result, store } = await payOut(deposit);

    assert.equal(result.status, "paid", show(result));
    assert.equal(store.checkpoint!.plan.networkCost, estimate);
    assert.equal((result as Extract<PayoutResult, { status: "paid" }>).transfers[0]!.amount, invoiceAmount);
    assert.equal(await unlockedAt(chain.wallets.merchant, merchantSubaddress.index), merchantBefore + invoiceAmount);
  });

  it("stops with a where-the-money-is message for a destination it can't pay, and sends nothing", async () => {
    const deposit = await fundedDeposit([XMR]);
    const integrated = await must<{ integrated_address: string }>(chain.wallets.merchant, "make_integrated_address", {});
    const ownAddress = chain.addresses.platform;

    for (const destination of [integrated.integrated_address, ownAddress, deposit.address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"]) {
      const { store, save } = checkpointStore();
      const result = await adapter.payout(request(deposit, { save, checkpoint: undefined, destination }));
      assert.equal(result.status, "failed", destination);
      assert.match((result as { message: string }).message, new RegExp(`deposit address ${deposit.address}`));
      assert.equal(store.saves, 0);
    }
    assert.equal(await unlockedAt(chain.wallets.platform, deposit.key.index), XMR);
  });
});
