import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Address, beginCell, toNano, type Transaction } from "@ton/core";

import { fakeAppEnv } from "../../helpers/fake-env.js";
import cryptos from "../../../src/storage/cryptos.json" with { type: "json" };

// The USDT-on-TON adapter end to end on @ton/sandbox: real W5 wallets and
// TON's stablecoin jetton (the USDT design), its minter placed at the real
// USDT master address, so the adapter runs with cryptos.json unchanged. The
// adapter's toncenter calls are answered from the emulator (emulator.ts).

Object.assign(process.env, fakeAppEnv());

const { createTonJettonAdapter } = await import("../../../src/chains/ton.js");
const { parseFeeRate, payerPaysAskedAmount } = await import("../../../src/money/payout-split.js");
const { sealSecret } = await import("../../../src/security/secret-envelope.js");
const {
  GAS_WALLET_FEE_BUDGET,
  JETTON_DEPOSIT_DEPLOY_COST,
  JETTON_DEPOSIT_FEE_BUDGET,
  JETTON_GAS_WALLET_COST,
  JETTON_TRANSFER_TON,
  JETTON_TRANSFERS_COST,
  jettonPayoutCharge,
} = await import(
  "../../../src/transactions/ton-jetton.js"
);
const { accountOf, createTonEmulator } = await import("./emulator.js");

type Adapter = ReturnType<typeof createTonJettonAdapter>;
type Request = Parameters<Adapter["payout"]>[0];
type Checkpoint = NonNullable<Request["checkpoint"]>;
type Result = Awaited<ReturnType<Adapter["payout"]>>;

const em = await createTonEmulator();
const { chain, history, options } = em;
const admin = await chain.treasury("admin");
const payer = await chain.treasury("payer");
const USDT_MASTER = Address.parse(cryptos.usdtton.jetton_master);
const usdt = await em.deployJetton(admin, USDT_MASTER);

const text = (address: Address) => address.toString({ bounceable: false });
const platform = await em.deployedWallet(payer);
// The platform already holds USDT, as it will after its first fee.
await usdt.mint(payer.address, 1n);
await usdt.transfer(payer, platform.address, 1n);

// The gas wallet starts funded but not deployed: its first top-up deploys it.
const gas = await em.newWallet();
em.record(await payer.send({ to: gas.address, value: toNano("50"), bounce: false }));
const gasKey = sealSecret("ton-gas-wallet-key", gas.words.join(" "));

// 1 TON = 3 USD, 1 USDT = 1 USD.
const prices: Record<string, string | undefined> = { ton: "3", usdtton: "1" };
const getPrice = async (asset: string) => prices[asset];

const make = (overrides: Partial<Parameters<typeof createTonJettonAdapter>[0]> = {}) =>
  createTonJettonAdapter({
    asset: "usdtton",
    platformAddress: text(platform.address),
    gasWalletKey: gasKey,
    getPrice,
    api: em.api,
    ...overrides,
  });
const adapter = make();

const FIVE_PERCENT = parseFeeRate("0.05")!;
const ZERO = parseFeeRate("0")!;

/** USDT units (6 decimals) for `nanoton` at 3 USD per TON, rounded up. */
const usdtFor = (nanoton: bigint) => (nanoton * 3n * 10n ** 6n + 10n ** 9n - 1n) / 10n ** 9n;
// A payer's wallet sends 1 nanoton with its notification, so a fresh deposit
// holds 1 nanoton of TON when the payout starts.
const FULL_TOP_UP = 2n * JETTON_TRANSFER_TON + JETTON_DEPOSIT_FEE_BUDGET - 1n;
// What a first payout to a merchant with no USDT yet is charged (fix ticket
// F): its measured cost, less that 1 nanoton.
const NEW_MERCHANT_CHARGE = jettonPayoutCharge({ depositDeployed: false, newJettonWallets: 1, depositTon: 1n });
const FULL_REIMBURSEMENT = usdtFor(NEW_MERCHANT_CHARGE);
// What the code before fix ticket F charged: the gas wallet's whole planned spend.
const OLD_CHARGE = FULL_TOP_UP + GAS_WALLET_FEE_BUDGET;

/** A deposit made by the adapter, paid `amount` USDT by the payer, and a payout request for it. */
async function paidDeposit(amount: bigint, destination: Address, feeRate = FIVE_PERCENT, fields: Partial<Request> = {}) {
  const deposit = await adapter.newDeposit();
  const address = Address.parse(deposit.address);
  if (amount > 0n) {
    await usdt.mint(payer.address, amount);
    await usdt.transfer(payer, address, amount);
  }
  const saved: Checkpoint[] = [];
  let allowSave = true;
  const request = (checkpoint?: Checkpoint, overrides: Partial<Request> = {}): Request => ({
    depositAddress: deposit.address,
    depositKey: deposit.key,
    destination: text(destination),
    destinationKind: "merchant_payout",
    receiveAsset: "usdtton",
    feeRate,
    minimumAmount: amount,
    checkpoint,
    saveCheckpoint: async (next) => {
      if (!allowSave) return false;
      saved.push(next);
      return true;
    },
    ...fields,
    ...overrides,
  });
  return { address, text: deposit.address, key: deposit.key, saved, request, refuseSaves: () => (allowSave = false) };
}

/** Calls the payout with the latest saved checkpoint until it stops being pending. */
async function payToEnd(d: Awaited<ReturnType<typeof paidDeposit>>, calls = 8): Promise<Result> {
  let result: Result = { status: "pending", reason: "not called" };
  for (let i = 0; i < calls && result.status === "pending"; i++) {
    result = await adapter.payout(d.request(d.saved.at(-1)));
  }
  return result;
}

const sentBy = (address: Address, from = 0) =>
  history.slice(from).filter((tx) => accountOf(tx).equals(address) && tx.inMessage?.info.type === "external-in");

function internalOut(tx: Transaction) {
  return [...tx.outMessages.values()].flatMap((m) => (m.info.type === "internal" ? [{ info: m.info, body: m.body }] : []));
}

// ---------- tests ----------

describe("USDT on TON deposits and payments", () => {
  it("gives each invoice a fresh, non-bounceable TON wallet address with its own sealed key", async () => {
    const [a, b] = [await adapter.newDeposit(), await adapter.newDeposit()];

    assert.ok(a.address.startsWith("UQ"), a.address);
    assert.notEqual(a.address, b.address);
    assert.equal(a.key.kind, "sealed_key");
  });

  it("lists each jetton transfer to the deposit's USDT jetton wallet: tx hash, USDT units, chain time", async () => {
    const d = await paidDeposit(0n, platform.address);
    await usdt.mint(payer.address, 3_000_000n);
    const firstAt = chain.now!;
    await usdt.transfer(payer, d.address, 1_000_000n);
    chain.now! += 3600;
    await usdt.transfer(payer, d.address, 2_000_000n, { forwardTon: 0n });

    const payments = await adapter.getPayments(d.text);

    assert.ok(payments);
    const ordered = [...payments].sort((a, b) => a.seenAt! - b.seenAt!);
    assert.deepEqual(
      ordered.map((p) => [p.amount, p.seenAt, p.confirmations]),
      [[1_000_000n, firstAt * 1000, 1], [2_000_000n, (firstAt + 3600) * 1000, 1]],
    );
    assert.ok(payments.every((p) => /^[0-9a-f]{64}$/.test(p.txid)));
  });

  it("never counts a fake jetton sent to the deposit, even with the same code and a transfer notification", async () => {
    const fake = await em.deployJetton(admin);
    const d = await paidDeposit(0n, platform.address);
    await fake.mint(payer.address, 50_000_000n);
    await fake.transfer(payer, d.address, 50_000_000n);
    assert.equal(await fake.balanceOf(d.address), 50_000_000n, "the fake really reached the deposit");

    assert.deepEqual(await adapter.getPayments(d.text), []);
  });

  it("never counts a forged internal_transfer sent straight to the deposit's real jetton wallet", async () => {
    const d = await paidDeposit(1_000_000n, platform.address);
    const forged = beginCell()
      .storeUint(0x178d4519, 32)
      .storeUint(7, 64)
      .storeCoins(900_000_000n)
      .storeAddress(payer.address)
      .storeAddress(payer.address)
      .storeCoins(0)
      .storeBit(false)
      .endCell();
    em.record(await payer.send({ to: await usdt.walletOf(d.address), value: toNano("0.05"), bounce: true, body: forged }));

    const payments = await adapter.getPayments(d.text);

    assert.deepEqual(payments?.map((p) => p.amount), [1_000_000n]);
    assert.equal(await usdt.balanceOf(d.address), 1_000_000n);
  });

  it("answers 'unknown' rather than a short list when the listing misses a payment", async () => {
    const d = await paidDeposit(1_000_000n, platform.address);
    await usdt.mint(payer.address, 1_000_000n);
    await usdt.transfer(payer, d.address, 1_000_000n);
    options.listingLimit = 1;
    try {
      assert.equal(await adapter.getPayments(d.text), undefined);
    } finally {
      options.listingLimit = Infinity;
    }
  });

  it("estimates the network cost as a new deposit's measured payout cost to receivers holding USDT, in USDT units", async () => {
    assert.equal(await adapter.estimateNetworkCost(), usdtFor(JETTON_GAS_WALLET_COST + JETTON_TRANSFERS_COST + JETTON_DEPOSIT_DEPLOY_COST));
  });

  it("keeps TON's confirmation count", () => {
    assert.equal(adapter.requiredConfirmations, cryptos.ton.required_confirmations);
  });
});

describe("a USDT-on-TON payout", () => {
  it("at 5%: the merchant is charged the payout's real cost, not the TON sent along, which all comes back to the gas wallet", async (t) => {
    const merchant = await em.newWallet();
    const d = await paidDeposit(100_000_000n, merchant.address);
    const platformBefore = await usdt.balanceOf(platform.address);
    const gasBefore = await em.balanceOf(gas.address);
    const gasWasNew = (await chain.getContract(gas.address)).accountState?.type !== "active";
    // F1: fee = 5% of 100 USDT; the gas wallet's planned spend, in USDT, comes off the merchant's share.
    const fee = 5_000_000n;
    const merchantAmount = 100_000_000n - fee - FULL_REIMBURSEMENT;

    const first = await adapter.payout(d.request());

    assert.equal(first.status, "pending");
    assert.equal(d.saved.length, 1);
    const plan = d.saved[0]!.plan;
    assert.equal(plan.platformFee, fee);
    assert.equal(plan.networkCost, FULL_REIMBURSEMENT);
    assert.deepEqual(
      plan.transfers.map((t) => [t.kind, t.to, t.amount]),
      [
        ["gas_top_up", d.text, FULL_TOP_UP + GAS_WALLET_FEE_BUDGET],
        ["merchant_payout", text(merchant.address), merchantAmount],
        ["platform_fee", text(platform.address), fee + FULL_REIMBURSEMENT],
      ],
    );

    const result = await payToEnd(d);

    assert.equal(result.status, "paid", JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (result.status !== "paid") return;
    assert.deepEqual(
      result.transfers.map((t) => [t.kind, t.to]),
      [
        ["gas_top_up", d.text],
        ["merchant_payout", text(merchant.address)],
        ["platform_fee", text(platform.address)],
        ["gas_sweep", text(gas.address)],
        ["gas_sweep", text(gas.address)],
      ],
    );
    assert.equal(await usdt.balanceOf(merchant.address), merchantAmount);
    assert.equal((await usdt.balanceOf(platform.address)) - platformBefore, fee + FULL_REIMBURSEMENT);
    assert.equal(await usdt.balanceOf(d.address), 0n);
    assert.deepEqual(result.transfers.slice(1, 3).map((t) => t.amount), [merchantAmount, fee + FULL_REIMBURSEMENT]);
    const topUpSpent = result.transfers[0]!.amount;
    assert.ok(topUpSpent > FULL_TOP_UP && topUpSpent <= FULL_TOP_UP + GAS_WALLET_FEE_BUDGET, `top-up spent ${topUpSpent}`);
    const swept = result.transfers.slice(3).reduce((sum, t) => sum + t.amount, 0n);
    const realSpend = gasBefore - (await em.balanceOf(gas.address));
    assert.equal(await em.balanceOf(d.address), 0n, "the deposit keeps no TON");
    assert.ok(topUpSpent - swept < realSpend, "the gas wallet paid a little to take the excesses in");
    // The payer's 1 nanoton at the deposit was credited, then swept along. The
    // suite's first top-up also deploys the gas wallet, once: the platform's cost.
    const extra = realSpend - (NEW_MERCHANT_CHARGE + 1n);
    assert.ok(extra === 0n || (gasWasNew && extra > 0n && extra < 1_000_000n), `real ${realSpend}, charged ${NEW_MERCHANT_CHARGE}`);
    t.diagnostic(`ton jetton payout, nanoton: old charge ${OLD_CHARGE}, new charge ${NEW_MERCHANT_CHARGE}, real spend ${realSpend} (gas wallet deployed by it: ${gasWasNew}), swept back ${swept}`);
  });

  it("sends the top-up non-bounceable, the deposit's commands bounceable, unused TON to the gas wallet, and 1 nanoton forward to the destination", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(20_000_000n, merchant.address);
    const from = history.length;
    const gasBefore = await em.balanceOf(gas.address);

    assert.equal((await payToEnd(d)).status, "paid");
    assert.equal(gasBefore - (await em.balanceOf(gas.address)), NEW_MERCHANT_CHARGE + 1n, "the gas wallet's real spend is the charge");

    const [topUp] = sentBy(gas.address, from);
    assert.ok(topUp);
    const toDeposit = internalOut(topUp).filter((m) => m.info.dest.equals(d.address));
    assert.equal(toDeposit.length, 1);
    assert.equal(toDeposit[0]!.info.bounce, false);

    const [payout] = sentBy(d.address, from);
    assert.ok(payout);
    const commands = internalOut(payout);
    assert.equal(commands.length, 2);
    const depositJettonWallet = await usdt.walletOf(d.address);
    for (const [index, command] of commands.entries()) {
      assert.ok(command.info.dest.equals(depositJettonWallet));
      assert.equal(command.info.bounce, true);
      const body = command.body.beginParse();
      assert.equal(body.loadUint(32), 0x0f8a7ea5);
      body.loadUintBig(64);
      body.loadCoins();
      body.loadAddress();
      assert.ok(body.loadAddress().equals(gas.address), "response_destination is the gas wallet");
      body.loadMaybeRef();
      assert.equal(body.loadCoins(), index === 0 ? 1n : 0n);
    }
    assert.ok(commands[1]!.info.value.coins > JETTON_TRANSFER_TON, "the last command carries all the deposit's TON");
    assert.equal(await em.balanceOf(d.address), 0n);
  });

  it("at 0%: the only platform transfer is the gas reimbursement", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(30_000_000n, merchant.address, ZERO);
    const platformBefore = await usdt.balanceOf(platform.address);

    const result = await payToEnd(d);

    assert.equal(result.status, "paid");
    assert.equal(d.saved[0]!.plan.platformFee, 0n);
    assert.equal(await usdt.balanceOf(merchant.address), 30_000_000n - FULL_REIMBURSEMENT);
    assert.equal((await usdt.balanceOf(platform.address)) - platformBefore, FULL_REIMBURSEMENT);
  });

  it("charges the fee only on the part that has not paid it yet (a refunded swap's money); the gas is still reimbursed", async () => {
    const refund = await em.deployedWallet(payer);
    const d = await paidDeposit(30_000_000n, refund.address, FIVE_PERCENT, { destinationKind: "refund_route", feeExempt: 20_000_000n });
    const platformBefore = await usdt.balanceOf(platform.address);

    const result = await payToEnd(d);

    assert.equal(result.status, "paid");
    // 5% of (30 − 20) USDT = 0.5 USDT.
    assert.equal(d.saved[0]!.plan.platformFee, 500_000n);
    assert.equal(await usdt.balanceOf(refund.address), 30_000_000n - 500_000n - FULL_REIMBURSEMENT);
    assert.equal((await usdt.balanceOf(platform.address)) - platformBefore, 500_000n + FULL_REIMBURSEMENT);
  });

  it("routes late money after a completed payout to the refund address: its own checkpoint, minimum 1, a top-up only for what is missing", async () => {
    const merchant = await em.deployedWallet(payer);
    const refund = await em.deployedWallet(payer);
    const d = await paidDeposit(40_000_000n, merchant.address);
    assert.equal((await payToEnd(d)).status, "paid");
    const merchantPaid = await usdt.balanceOf(merchant.address);
    await usdt.mint(payer.address, 10_000_000n);
    await usdt.transfer(payer, d.address, 10_000_000n);
    const listed = await adapter.getPayments(d.text);
    assert.deepEqual(listed?.map((p) => p.amount).sort(), [10_000_000n, 40_000_000n]);

    // The first payout swept the deposit's TON; only the late payer's notification is there.
    const leftover = await em.balanceOf(d.address);
    assert.ok(leftover <= 1n, `left ${leftover}`);
    const needed = 2n * JETTON_TRANSFER_TON + JETTON_DEPOSIT_FEE_BUDGET;
    const topUp = needed - leftover;
    // The deposit is deployed now; the refund address has no USDT yet.
    const reimbursement = usdtFor(jettonPayoutCharge({ depositDeployed: true, newJettonWallets: 1, depositTon: leftover }));
    const fee = 500_000n;
    const refundAmount = 10_000_000n - fee - reimbursement;
    const route = { saved: [] as Checkpoint[] };
    const routeRequest = (checkpoint?: Checkpoint): Request => ({
      ...d.request(checkpoint),
      destination: text(refund.address),
      destinationKind: "refund_route",
      minimumAmount: 1n,
      saveCheckpoint: async (next) => {
        route.saved.push(next);
        return true;
      },
    });

    let result: Result = await adapter.payout(routeRequest());
    for (let i = 0; i < 6 && result.status === "pending"; i++) result = await adapter.payout(routeRequest(route.saved.at(-1)));

    assert.equal(result.status, "paid");
    if (result.status !== "paid") return;
    assert.equal(route.saved[0]!.plan.networkCost, reimbursement);
    assert.equal(route.saved[0]!.plan.transfers[0]!.amount, topUp + GAS_WALLET_FEE_BUDGET);
    const kinds = result.transfers.map((t) => t.kind);
    assert.deepEqual(kinds, ["gas_top_up", "refund_route", "platform_fee", "gas_sweep", "gas_sweep"]);
    assert.equal(await em.balanceOf(d.address), 0n);
    assert.equal(await usdt.balanceOf(refund.address), refundAmount);
    assert.equal(await usdt.balanceOf(merchant.address), merchantPaid, "the merchant was paid again");
    assert.equal(await usdt.balanceOf(d.address), 0n);
  });

  it("sends nothing when another run saved the payout first", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(10_000_000n, merchant.address);
    const gasBefore = await em.balanceOf(gas.address);
    d.refuseSaves();

    const result = await adapter.payout(d.request());

    assert.equal(result.status, "pending");
    assert.equal(await em.balanceOf(gas.address), gasBefore);
    assert.equal(await usdt.balanceOf(d.address), 10_000_000n);
  });

  it("after a crash right after the top-up checkpoint, sends that top-up once and pays once", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(10_000_000n, merchant.address);
    const from = history.length;
    options.sendFails = true; // the process dies after the save, before the broadcast
    try {
      assert.equal((await adapter.payout(d.request())).status, "pending");
    } finally {
      options.sendFails = false;
    }
    assert.equal(sentBy(gas.address, from).length, 0);

    const result = await payToEnd(d);
    const again = await adapter.payout(d.request(d.saved.at(-1)));

    assert.equal(result.status, "paid");
    assert.deepEqual(again, result, "a call after paid gives the same proof");
    const topUps = sentBy(gas.address, from).filter((tx) => internalOut(tx).some((m) => m.info.dest.equals(d.address)));
    assert.equal(topUps.length, 1);
    assert.equal(sentBy(d.address, from).length, 1);
    assert.equal(await usdt.balanceOf(merchant.address), 10_000_000n - 500_000n - FULL_REIMBURSEMENT);
  });

  it("after a crash right after the transfers checkpoint, sends those transfers once", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(10_000_000n, merchant.address);
    const from = history.length;
    assert.equal((await adapter.payout(d.request())).status, "pending"); // top-up saved and sent
    options.sendFails = true;
    try {
      assert.equal((await adapter.payout(d.request(d.saved.at(-1)))).status, "pending");
    } finally {
      options.sendFails = false;
    }
    assert.equal(JSON.parse(d.saved.at(-1)!.state).phase, "transfers");
    assert.equal(sentBy(d.address, from).length, 0);

    const result = await payToEnd(d);
    await adapter.payout(d.request(d.saved.at(-1)));
    await adapter.payout(d.request(d.saved[0]));

    assert.equal(result.status, "paid");
    assert.equal(sentBy(d.address, from).length, 1, "the deposit sent more than once");
    assert.equal(await usdt.balanceOf(merchant.address), 10_000_000n - 500_000n - FULL_REIMBURSEMENT);
  });

  it("rebuilds an expired top-up and expired transfers with the same seqno, so only one version can land", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(10_000_000n, merchant.address);
    options.sendFails = true;
    try {
      await adapter.payout(d.request());
      chain.now! += 400; // past valid_until (300 s) and the 60 s margin
      await adapter.payout(d.request(d.saved.at(-1))); // rebuilt top-up, saved, send fails
    } finally {
      options.sendFails = false;
    }
    assert.equal(d.saved.length, 2);
    const [oldTopUp, newTopUp] = d.saved.map((c) => JSON.parse(c.state).topUp.signed);
    assert.equal(newTopUp.seqno, oldTopUp.seqno);
    assert.notEqual(newTopUp.boc, oldTopUp.boc);

    await adapter.payout(d.request(d.saved.at(-1))); // resends the rebuilt top-up
    options.sendFails = true;
    try {
      await adapter.payout(d.request(d.saved.at(-1))); // transfers saved, send fails
      chain.now! += 400;
      await adapter.payout(d.request(d.saved.at(-1))); // transfers rebuilt
    } finally {
      options.sendFails = false;
    }
    const [oldTransfers, newTransfers] = d.saved.slice(-2).map((c) => JSON.parse(c.state).deposit);
    assert.equal(newTransfers.seqno, oldTransfers.seqno);
    assert.notEqual(newTransfers.boc, oldTransfers.boc);

    const result = await payToEnd(d);

    assert.equal(result.status, "paid");
    assert.equal(await em.api("sendBoc", { body: { boc: oldTopUp.boc } }), undefined, "the old top-up still landed");
    assert.equal(await em.api("sendBoc", { body: { boc: oldTransfers.boc } }), undefined, "the old transfers still landed");
    assert.equal(await usdt.balanceOf(merchant.address), 10_000_000n - 500_000n - FULL_REIMBURSEMENT);
  });

  it("says too small when the reimbursement would take it all: nothing saved, the gas wallet untouched", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(FULL_REIMBURSEMENT, merchant.address);
    const gasBefore = await em.balanceOf(gas.address);

    const result = await adapter.payout(d.request());

    assert.equal(result.status, "too_small");
    assert.equal(d.saved.length, 0);
    assert.equal(await em.balanceOf(gas.address), gasBefore);
  });

  it("payer-pays: paying exactly the asked amount leaves a merchant who holds USDT exactly the invoice amount", async () => {
    const merchant = await em.deployedWallet(payer);
    await usdt.mint(payer.address, 1n);
    await usdt.transfer(payer, merchant.address, 1n);
    const invoiceAmount = 25_000_000n;
    const estimate = await adapter.estimateNetworkCost();
    assert.ok(typeof estimate === "bigint");
    const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost: estimate, feeRate: FIVE_PERCENT });
    const d = await paidDeposit(asked, merchant.address);

    const result = await payToEnd(d);

    assert.equal(result.status, "paid");
    assert.equal(await usdt.balanceOf(merchant.address), 1n + invoiceAmount);
  });

  it("waits, with a review note and nothing sent, while the gas wallet key is missing; payments are still seen", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(10_000_000n, merchant.address);
    const noKey = make({ gasWalletKey: undefined });

    const result = await noKey.payout(d.request());

    assert.equal(result.status, "pending");
    if (result.status !== "pending") return;
    assert.match(result.review ?? "", /TON_GAS_WALLET_KEY/);
    assert.equal(d.saved.length, 0);
    assert.deepEqual((await noKey.getPayments(d.text))?.map((p) => p.amount), [10_000_000n]);
  });

  it("waits, with nothing sent, while a price is missing", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(10_000_000n, merchant.address);
    const noPrice = make({ getPrice: async (asset) => (asset === "ton" ? undefined : "1") });

    const result = await noPrice.payout(d.request());

    assert.equal(result.status, "pending");
    assert.equal(d.saved.length, 0);
    assert.equal(await noPrice.estimateNetworkCost(), undefined);
  });

  it("waits with a review note when the gas wallet can't pay the top-up", async () => {
    const poor = await em.newWallet();
    em.record(await payer.send({ to: poor.address, value: toNano("0.01"), bounce: false }));
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(10_000_000n, merchant.address);

    const result = await make({ gasWalletKey: sealSecret("ton-gas-wallet-key", poor.words.join(" ")) }).payout(d.request());

    assert.equal(result.status, "pending");
    if (result.status !== "pending") return;
    assert.match(result.review ?? "", /short of funds|Fund the gas wallet/);
    assert.equal(d.saved.length, 0);
  });

  it("stops before sending when the destination is a jetton wallet, not a normal wallet", async () => {
    const merchant = await em.deployedWallet(payer);
    await usdt.mint(merchant.address, 1n);
    const merchantJettonWallet = await usdt.walletOf(merchant.address);
    const d = await paidDeposit(10_000_000n, merchantJettonWallet);

    const result = await adapter.payout(d.request());

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.message, /not a normal TON wallet/);
    assert.ok(result.message.includes(`still at deposit address ${d.text}`));
    assert.equal(d.saved.length, 0);
  });

  it("fails with where the money is when the deposit's own jetton wallet refuses, and its TON comes back (bounceable)", async () => {
    const merchant = await em.deployedWallet(payer);
    const d = await paidDeposit(10_000_000n, merchant.address);
    await usdt.setStatus(d.address, 1); // the issuer blocks the deposit's jetton wallet from sending

    const result = await payToEnd(d);

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.message, /refused/);
    assert.ok(result.message.includes(d.text));
    assert.equal(await usdt.balanceOf(d.address), 10_000_000n);
    assert.equal(await usdt.balanceOf(merchant.address), 0n);
    assert.ok((await em.balanceOf(d.address)) > JETTON_TRANSFER_TON, "the TON sent with the transfers came back");
  });

  it("fails with where the money is when the merchant's jetton wallet refuses, and the bounced tokens are not a new payment", async () => {
    const merchant = await em.deployedWallet(payer);
    await usdt.mint(merchant.address, 1n);
    await usdt.setStatus(merchant.address, 2); // the issuer blocks it from receiving
    const d = await paidDeposit(10_000_000n, merchant.address);

    const result = await payToEnd(d);

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.message, /refused/);
    assert.ok(result.message.includes(d.text));
    assert.equal(await usdt.balanceOf(merchant.address), 1n);
    assert.ok((await usdt.balanceOf(d.address)) > 0n, "the merchant's share bounced back to the deposit");
    assert.deepEqual(result.transfers.map((t) => t.kind), ["gas_top_up", "platform_fee"]);
    assert.deepEqual((await adapter.getPayments(d.text))?.map((p) => p.amount), [10_000_000n]);
  });
});
