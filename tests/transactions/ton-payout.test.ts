import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
import litecore from "bitcore-lib-ltc";

// TON payout rules that must never silently change. Runs in @ton/sandbox: the
// real TVM with the real W5 wallet code. No database, no network.
//
// Run this file on its own:
//   node --import tsx --test tests/transactions/ton-payout.test.ts
// (not `npm test`: the old suite deletes data in the database from .env).

// Fake config, set before the app's modules load. DOTENV_CONFIG_PATH=/dev/null
// stops dotenv from reading the real .env.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: "/dev/null",
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://127.0.0.1:1/never-connected",
  MONGODB_DATABASE: "never_connected",
  DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ACCOUNT_LOOKUP_HMAC_KEY: randomBytes(32).toString("base64"),
  NOWNODES_API_KEY: "fake-nownodes-key",
  NEAR_INTENTS: "fake-near-jwt",
  PLATFORM_BTC_ADDRESS: "bc1qfake",
  PLATFORM_ETH_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  PLATFORM_LTC_ADDRESS: new litecore.PrivateKey().toAddress().toString(),
  PLATFORM_SOL_ADDRESS: "11111111111111111111111111111111",
  PLATFORM_TON_ADDRESS: "UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_",
});

const { signTonPayout, findPayoutBySeqno, paidExactly } = await import(
  "../../src/transactions/ton.js"
);
const { generateTonAddress } = await import("../../src/crypto/ton.js");
const { openSecret } = await import("../../src/security/secret-envelope.js");

// ---------- emulator helpers ----------

const chain = await Blockchain.create();
chain.now = Math.floor(Date.now() / 1000);
const payer = await chain.treasury("payer");

/** A W5 wallet from a fresh 24-word key, like a deposit address. */
async function newWallet() {
  const keyPair = await mnemonicToPrivateKey(await mnemonicNew(24));
  const contract = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  return { contract, secretKey: keyPair.secretKey, address: contract.address };
}

/** A W5 wallet that is already deployed (has code), like a merchant's. */
async function deployedWallet() {
  const wallet = await newWallet();
  await payer.send({ to: wallet.address, value: toNano("1"), bounce: false });
  await chain.openContract(wallet.contract).sendTransfer({
    seqno: 0,
    secretKey: wallet.secretKey,
    messages: [],
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
  });
  assert.equal((await chain.getContract(wallet.address)).accountState?.type, "active");
  return wallet;
}

async function balanceOf(address: Address) {
  return (await chain.getContract(address)).balance;
}

function accountOf(tx: Transaction) {
  return new Address(0, Buffer.from(tx.address.toString(16).padStart(64, "0"), "hex"));
}

/** The transactions of `address` among `txs`. */
function txsAt(txs: Transaction[], address: Address) {
  return txs.filter((tx) => accountOf(tx).equals(address));
}

function toBoc(tx: Transaction) {
  return beginCell().store(storeTransaction(tx)).endCell().toBoc().toString("base64");
}

/**
 * Funds a new deposit wallet with `funded`, then signs and runs its first
 * payout (it deploys the wallet), exactly as the payout code builds it.
 */
async function runFirstPayout(input: {
  funded: bigint;
  receiver: Address;
  amount: bigint;
  platform: Address;
}) {
  const deposit = await newWallet();
  await payer.send({ to: deposit.address, value: input.funded, bounce: false });

  const signed = signTonPayout({
    wallet: { contract: deposit.contract, secretKey: deposit.secretKey },
    seqno: 0,
    deploy: true,
    validUntil: chain.now! + 300,
    receiver: input.receiver,
    amount: input.amount,
    platform: input.platform,
  });
  const result = await chain.sendMessage(Cell.fromBase64(signed.boc));

  const [payoutTx] = txsAt(result.transactions, deposit.address);
  assert.ok(payoutTx, "the deposit wallet ran the payout");
  return { deposit, txs: result.transactions, payoutTx, landed: findPayoutBySeqno([toBoc(payoutTx)], 0) };
}

const platform = await deployedWallet();

// ---------- tests ----------

describe("every payout message is non-bounceable", () => {
  for (const kind of ["already deployed", "brand new"] as const) {
    it(`receiver ${kind}: both messages have bounce=false`, async () => {
      const receiver = kind === "brand new" ? await newWallet() : await deployedWallet();
      const before = await balanceOf(receiver.address);

      const { payoutTx, landed } = await runFirstPayout({
        funded: toNano("3"),
        receiver: receiver.address,
        amount: toNano("2"),
        platform: platform.address,
      });

      const created = [...payoutTx.outMessages.values()];
      assert.equal(created.length, 2, "receiver message + platform message");
      for (const message of created) {
        assert.equal(message.info.type, "internal");
        if (message.info.type === "internal") assert.equal(message.info.bounce, false);
      }

      assert.ok(landed);
      assert.equal(landed.failed, undefined);
      assert.ok(paidExactly(landed.sent, receiver.address, toNano("2")));
      assert.ok((await balanceOf(receiver.address)) >= before + toNano("2") - toNano("0.01"));
    });
  }
});

describe("paying a contract that always fails still delivers the money", () => {
  it("credits the exact amount and sends nothing back", async () => {
    // Code: THROW 36. Every message to it fails in the compute phase.
    const failing = {
      code: beginCell().storeUint(0xf224, 16).endCell(),
      data: new Cell(),
    };
    const failingAddress = contractAddress(0, failing);
    await payer.send({ to: failingAddress, value: toNano("1"), bounce: false, init: failing });
    assert.equal((await chain.getContract(failingAddress)).accountState?.type, "active");
    const before = await balanceOf(failingAddress);

    const amount = toNano("2");
    const { deposit, txs, landed } = await runFirstPayout({
      funded: toNano("3"),
      receiver: failingAddress,
      amount,
      platform: platform.address,
    });

    const [received] = txsAt(txs, failingAddress);
    assert.ok(received, "the contract handled our message");
    const d = received.description;
    assert.equal(d.type, "generic");
    if (d.type !== "generic") return;
    assert.ok(d.computePhase.type === "vm" && !d.computePhase.success, "its code really failed");
    assert.equal(d.creditPhase?.credit.coins, amount, "credited exactly the amount");
    assert.equal(received.outMessagesCount, 0, "sent nothing back");

    // Nothing came back to the deposit after its payout transaction.
    assert.equal(txsAt(txs, deposit.address).length, 1);
    assert.equal(await balanceOf(deposit.address), 0n);
    assert.ok((await balanceOf(failingAddress)) > before + amount - toNano("0.01"));

    assert.ok(landed && paidExactly(landed.sent, failingAddress, amount));
  });
});

describe("success is decided from the messages sent, not the status", () => {
  it("status says success, but the receiver message was skipped", async () => {
    const receiver = await deployedWallet();
    const platformBefore = await balanceOf(platform.address);

    // Asks for 5 TON from a wallet holding 1: with +2 (ignore errors) the
    // receiver message is skipped and the transaction still "succeeds".
    const { payoutTx, landed } = await runFirstPayout({
      funded: toNano("1"),
      receiver: receiver.address,
      amount: toNano("5"),
      platform: platform.address,
    });

    const d = payoutTx.description;
    assert.ok(d.type === "generic" && d.actionPhase?.success, "the action phase says success");
    assert.ok(landed);
    assert.equal(landed.failed, undefined, "the status checks see nothing wrong");
    assert.equal(paidExactly(landed.sent, receiver.address, toNano("5")), false);

    // Where the money is: message 2 (mode 128) took everything to the platform.
    assert.equal(landed.sent.length, 1);
    assert.ok(landed.sent[0]!.to.equals(platform.address));
    assert.ok((await balanceOf(platform.address)) > platformBefore + toNano("0.99"));
  });

  it("accepts only the exact amount, to the receiver, non-bounceable", () => {
    const receiver = Address.parse("UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_");
    const other = platform.address;

    assert.equal(paidExactly([{ to: receiver, value: 5n, bounce: false }], receiver, 5n), true);
    assert.equal(paidExactly([{ to: receiver, value: 5n, bounce: true }], receiver, 5n), false);
    assert.equal(paidExactly([{ to: receiver, value: 4n, bounce: false }], receiver, 5n), false);
    assert.equal(paidExactly([{ to: other, value: 5n, bounce: false }], receiver, 5n), false);
    assert.equal(paidExactly([], receiver, 5n), false);
  });
});

describe("mainnet deposit addresses never change", () => {
  // Recorded on 2026-11-15 from the code before the testnet switch. If this
  // fails, new deposit addresses would no longer match the keys in the
  // database for the same formula: do not "fix" the expected value.
  it("a fixed public key gives the recorded address", () => {
    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: Buffer.alloc(32, 1),
    });
    assert.equal(
      wallet.address.toString({ urlSafe: true, bounceable: false, testOnly: false }),
      "UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_",
    );
  });

  it("generateTonAddress matches the key in its own sealed secret", async () => {
    const { address, encryptedPrivateKey } = await generateTonAddress();
    const keyPair = await mnemonicToPrivateKey(
      openSecret("ton-deposit-key", encryptedPrivateKey).split(" "),
    );
    keyPair.secretKey.fill(0);

    const expected = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
    assert.equal(
      address,
      expected.address.toString({ urlSafe: true, bounceable: false, testOnly: false }),
    );
  });
});
