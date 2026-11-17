import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Blockchain } from "@ton/sandbox";
import {
  Address,
  beginCell,
  Cell,
  contractAddress,
  SendMode,
  storeTransaction,
  toNano,
  type Transaction,
} from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";

import { fakeAppEnv } from "../helpers/fake-env.js";

// The TON chain adapter, end to end on @ton/sandbox: the real TVM with the
// real W5 wallet code. The adapter's toncenter calls are answered from the
// emulator in the toncenter v2 shapes the adapter reads. No database, no
// network.

Object.assign(process.env, fakeAppEnv());

const { createTonAdapter } = await import("../../src/chains/ton.js");
const { parseFeeRate } = await import("../../src/money/payout-split.js");
type Adapter = ReturnType<typeof createTonAdapter>;
type Request = Parameters<Adapter["payout"]>[0];
type Checkpoint = NonNullable<Request["checkpoint"]>;
type TonApi = NonNullable<Parameters<typeof createTonAdapter>[0]["api"]>;

// ---------- the emulator, behind a toncenter-shaped API ----------

const chain = await Blockchain.create();
chain.now = Math.floor(Date.now() / 1000);
const history: Transaction[] = [];
const payer = await chain.treasury("payer");

function accountOf(tx: Transaction) {
  return new Address(0, Buffer.from(tx.address.toString(16).padStart(64, "0"), "hex"));
}

function toBoc(tx: Transaction) {
  return beginCell().store(storeTransaction(tx)).endCell().toBoc().toString("base64");
}

const W5_CODE_HASH = WalletContractV5R1.create({ workchain: 0, publicKey: Buffer.alloc(32) }).init.code.hash();

/** Options a test can turn on to make the API misbehave. */
const api = {
  sendFails: false,
  listingLimit: Infinity,
};

const emulatorApi: TonApi = async (method, request) => {
  const address = request.query?.address ? Address.parse(request.query.address) : undefined;
  if (method === "sendBoc") {
    if (api.sendFails) return undefined;
    try {
      const result = await chain.sendMessage(Cell.fromBase64((request.body as { boc: string }).boc));
      history.push(...result.transactions);
      return {};
    } catch {
      return undefined; // the wallet refused it, e.g. a used seqno
    }
  }
  if (address === undefined) throw new Error(`no address for ${method}`);
  const contract = await chain.getContract(address);
  const state = contract.accountState;
  const accountState = state?.type === "active" ? "active" : state?.type === "frozen" ? "frozen" : "uninitialized";

  switch (method) {
    case "getAddressInformation":
      return {
        balance: contract.balance.toString(),
        state: accountState,
        code: state?.type === "active" && state.state.code ? state.state.code.toBoc().toString("base64") : "",
        data: state?.type === "active" && state.state.data ? state.state.data.toBoc().toString("base64") : "",
        sync_utime: chain.now,
      };
    case "getWalletInformation":
      return {
        wallet: state?.type === "active" && state.state.code?.hash().equals(W5_CODE_HASH) === true,
        account_state: accountState,
      };
    case "getTransactions": {
      const limit = Math.min(Number(request.query?.limit), api.listingLimit);
      return history
        .filter((tx) => accountOf(tx).equals(address))
        .reverse()
        .slice(0, limit)
        .map((tx) => ({ data: toBoc(tx) }));
    }
    default:
      throw new Error(`the emulator API has no ${method}`);
  }
};

async function pay(to: Address, value: bigint, bounce = false) {
  const result = await payer.send({ to, value, bounce });
  history.push(...result.transactions);
}

async function newWallet() {
  const keyPair = await mnemonicToPrivateKey(await mnemonicNew(24));
  const contract = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
  return { contract, secretKey: keyPair.secretKey, address: contract.address };
}

/** A W5 wallet that is already deployed, like a merchant's. */
async function deployedWallet() {
  const wallet = await newWallet();
  await pay(wallet.address, toNano("1"));
  const result = await chain.openContract(wallet.contract).sendTransfer({
    seqno: 0,
    secretKey: wallet.secretKey,
    messages: [],
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    timeout: chain.now! + 60,
  });
  history.push(...result.transactions);
  return wallet;
}

async function balanceOf(address: Address) {
  return (await chain.getContract(address)).balance;
}

const text = (address: Address) => address.toString({ bounceable: false });

const platform = await deployedWallet();
const ton = createTonAdapter({ platformAddress: text(platform.address), api: emulatorApi });
const FEE_RATE = parseFeeRate("0.05")!;

/** A funded deposit made by the adapter, and a payout request for it. */
async function fundedDeposit(funded: bigint, destination: Address) {
  const deposit = await ton.newDeposit();
  await pay(Address.parse(deposit.address), funded);
  const saved: Checkpoint[] = [];
  let allowSave = true;
  const request = (checkpoint?: Checkpoint): Request => ({
    depositAddress: deposit.address,
    depositKey: deposit.key,
    destination: text(destination),
    destinationKind: "merchant_payout",
    receiveAsset: "ton",
    feeRate: FEE_RATE,
    minimumAmount: funded,
    checkpoint,
    saveCheckpoint: async (next) => {
      if (!allowSave) return false;
      saved.push(next);
      return true;
    },
  });
  return {
    deposit: Address.parse(deposit.address),
    depositText: deposit.address,
    saved,
    request,
    refuseSaves: () => (allowSave = false),
  };
}

/** The transactions in which `receiver` was credited by a message from `from`. */
function creditsFrom(from: Address, receiver: Address) {
  return history.filter(
    (tx) =>
      accountOf(tx).equals(receiver) &&
      tx.inMessage?.info.type === "internal" &&
      tx.inMessage.info.src.equals(from),
  );
}

// 3 TON at 5% with the 0.005 TON fee budget:
// fee = 0.15 TON, merchant = 3 − 0.15 − 0.005 = 2.845 TON
const FUNDED = toNano("3");
const MERCHANT_AMOUNT = 2_845_000_000n;
const PLATFORM_FEE = 150_000_000n;
const NETWORK_COST = 5_000_000n;

// ---------- tests ----------

describe("TON deposits", () => {
  it("makes a non-bounceable deposit address whose sealed key the adapter can spend from", async () => {
    const deposit = await ton.newDeposit();

    assert.equal(deposit.key.kind, "sealed_key");
    assert.ok(deposit.address.startsWith("UQ"), deposit.address);
  });
});

describe("TON chain data", () => {
  it("lists each payment with the exact amount credited and its chain time", async () => {
    const deposit = Address.parse((await ton.newDeposit()).address);
    const firstAt = chain.now!;
    await pay(deposit, toNano("1"));
    chain.now! += 3600;
    await pay(deposit, toNano("0.5"));

    const payments = await ton.getPayments(text(deposit));

    assert.ok(payments);
    const bySeenAt = [...payments].sort((a, b) => a.seenAt! - b.seenAt!);
    assert.deepEqual(
      bySeenAt.map((p) => [p.amount, p.seenAt]),
      [[toNano("1"), firstAt * 1000], [toNano("0.5"), (firstAt + 3600) * 1000]],
    );
    assert.ok(payments.every((p) => p.confirmations === 1 && /^[0-9a-f]{64}$/.test(p.txid)));
  });

  it("does not count a bounceable payment the new deposit sent back", async () => {
    const deposit = Address.parse((await ton.newDeposit()).address);
    await pay(deposit, toNano("1"), true);

    assert.deepEqual(await ton.getPayments(text(deposit)), []);
  });

  it("answers 'unknown' rather than a short list when the listing misses a payment", async () => {
    const deposit = Address.parse((await ton.newDeposit()).address);
    await pay(deposit, toNano("1"));
    await pay(deposit, toNano("2"));
    api.listingLimit = 1;
    try {
      assert.equal(await ton.getPayments(text(deposit)), undefined);
    } finally {
      api.listingLimit = Infinity;
    }
  });
});

describe("a TON payout through the adapter", () => {
  it("saves the signed payout, sends it, then proves the exact amount reached the merchant", async () => {
    const merchant = await deployedWallet();
    const d = await fundedDeposit(FUNDED, merchant.address);

    const first = await ton.payout(d.request());

    assert.equal(first.status, "pending");
    assert.equal(d.saved.length, 1);
    const { plan } = d.saved[0]!;
    assert.equal(plan.platformFee, PLATFORM_FEE);
    assert.equal(plan.networkCost, NETWORK_COST);
    assert.deepEqual(
      plan.transfers.map((t) => [t.kind, t.to, t.amount]),
      [["merchant_payout", text(merchant.address), MERCHANT_AMOUNT], ["platform_fee", text(platform.address), PLATFORM_FEE]],
    );

    const second = await ton.payout(d.request(d.saved[0]));

    assert.equal(second.status, "paid");
    if (second.status !== "paid") return;
    const [toMerchant, toPlatform] = second.transfers;
    assert.deepEqual([toMerchant!.kind, toMerchant!.to, toMerchant!.amount], ["merchant_payout", text(merchant.address), MERCHANT_AMOUNT]);
    assert.equal(toPlatform!.kind, "platform_fee");
    assert.ok(toPlatform!.amount > PLATFORM_FEE && toPlatform!.amount <= PLATFORM_FEE + NETWORK_COST);
    assert.equal(toMerchant!.txid, toPlatform!.txid);

    const [credit] = creditsFrom(d.deposit, merchant.address);
    assert.ok(credit && credit.inMessage?.info.type === "internal");
    assert.equal(credit.inMessage.info.value.coins, MERCHANT_AMOUNT);
    assert.equal(credit.inMessage.info.bounce, false);
    assert.equal(await balanceOf(d.deposit), 0n);
  });

  it("delivers to a brand-new merchant wallet with no code, non-bounceable (ADR 0001)", async () => {
    const merchant = await newWallet();
    const d = await fundedDeposit(FUNDED, merchant.address);

    await ton.payout(d.request());
    const result = await ton.payout(d.request(d.saved[0]));

    assert.equal(result.status, "paid");
    assert.equal(await balanceOf(merchant.address), MERCHANT_AMOUNT);
    const sentByDeposit = history
      .filter((tx) => accountOf(tx).equals(d.deposit))
      .flatMap((tx) => [...tx.outMessages.values()]);
    assert.ok(sentByDeposit.length > 0);
    for (const message of sentByDeposit) {
      assert.ok(message.info.type === "internal" && message.info.bounce === false);
    }
  });

  it("sends nothing when another run saved the payout first", async () => {
    const merchant = await deployedWallet();
    const d = await fundedDeposit(FUNDED, merchant.address);
    d.refuseSaves();

    const result = await ton.payout(d.request());

    assert.equal(result.status, "pending");
    assert.equal(await balanceOf(d.deposit), FUNDED);
    assert.deepEqual(creditsFrom(d.deposit, merchant.address), []);
  });

  it("proves a landed payout again after a crash, without paying twice", async () => {
    const merchant = await deployedWallet();
    const d = await fundedDeposit(FUNDED, merchant.address);
    await ton.payout(d.request());
    const once = await ton.payout(d.request(d.saved[0]));

    const again = await ton.payout(d.request(d.saved[0]));

    assert.deepEqual(again, once);
    assert.equal(creditsFrom(d.deposit, merchant.address).length, 1);
  });

  it("sends the same message again while it can still land", async () => {
    const merchant = await deployedWallet();
    const d = await fundedDeposit(FUNDED, merchant.address);
    api.sendFails = true;
    try {
      assert.equal((await ton.payout(d.request())).status, "pending");
    } finally {
      api.sendFails = false;
    }
    assert.equal(await balanceOf(d.deposit), FUNDED, "the first send never arrived");

    assert.equal((await ton.payout(d.request(d.saved[0]))).status, "pending");
    const result = await ton.payout(d.request(d.saved[0]));

    assert.equal(result.status, "paid");
    assert.equal(d.saved.length, 1, "rebuilt a message that could still land");
    assert.equal(creditsFrom(d.deposit, merchant.address).length, 1);
  });

  it("rebuilds an expired message with the same seqno, so only one version can ever land", async () => {
    const merchant = await deployedWallet();
    const d = await fundedDeposit(FUNDED, merchant.address);
    api.sendFails = true;
    try {
      await ton.payout(d.request());
    } finally {
      api.sendFails = false;
    }
    chain.now! += 400; // past valid_until (300 s) and the 60 s margin

    const rebuilt = await ton.payout(d.request(d.saved[0]));

    assert.equal(rebuilt.status, "pending");
    assert.equal(d.saved.length, 2);
    assert.notEqual(d.saved[1]!.state, d.saved[0]!.state);
    const oldMessage = (JSON.parse(d.saved[0]!.state) as { boc: string }).boc;
    assert.equal(await emulatorApi("sendBoc", { body: { boc: oldMessage } }), undefined, "the old version still landed");

    const result = await ton.payout(d.request(d.saved[1]));
    assert.equal(result.status, "paid");
    assert.equal(creditsFrom(d.deposit, merchant.address).length, 1);
  });

  it("waits while the deposit holds less than the minimum", async () => {
    const merchant = await deployedWallet();
    const d = await fundedDeposit(FUNDED, merchant.address);

    const result = await ton.payout({ ...d.request(), minimumAmount: FUNDED + toNano("1") });

    assert.equal(result.status, "pending");
    assert.equal(d.saved.length, 0);
  });

  it("says too small when the fee budget would take it all", async () => {
    const merchant = await deployedWallet();
    const d = await fundedDeposit(toNano("0.004"), merchant.address);

    const result = await ton.payout(d.request());

    assert.equal(result.status, "too_small");
    assert.equal(d.saved.length, 0);
  });

  it("stops, saying where the money is, when the merchant address is not a wallet", async () => {
    // Code: THROW 36. A contract, not a wallet: funds sent there could be locked.
    const failing = { code: beginCell().storeUint(0xf224, 16).endCell(), data: new Cell() };
    const failingAddress = contractAddress(0, failing);
    const deployed = await payer.send({ to: failingAddress, value: toNano("1"), bounce: false, init: failing });
    history.push(...deployed.transactions);
    const d = await fundedDeposit(FUNDED, failingAddress);

    const result = await ton.payout(d.request());

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.message, /not a normal TON wallet/);
    assert.ok(result.message.includes(`All funds are still at deposit address ${d.depositText}`));
    assert.equal(await balanceOf(d.deposit), FUNDED);
  });

  it("stops when the saved key does not control the deposit", async () => {
    const merchant = await deployedWallet();
    const d = await fundedDeposit(FUNDED, merchant.address);
    const otherKey = (await ton.newDeposit()).key;

    const result = await ton.payout({ ...d.request(), depositKey: otherKey });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.match(result.message, new RegExp(`does not control deposit address ${d.depositText}`));
  });
});
