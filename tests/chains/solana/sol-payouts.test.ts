import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createKeyPairSignerFromPrivateKeyBytes, generateKeyPairSigner, getAddressEncoder, getBase58Decoder } from "@solana/kit";

import type { ChainAdapter, PayoutCheckpoint, PayoutRequest, PayoutResult } from "../../../src/chains/adapter.js";
import { createSolAdapter, createSplTokenAdapter } from "../../../src/chains/sol.js";
import type { SolanaRpc } from "../../../src/chains/solana-rpc.js";
import { ceilDivide } from "../../../src/money/format.js";
import { parseFeeRate, payerPaysAskedAmount } from "../../../src/money/payout-split.js";
import { sealSecret, type SealedSecret } from "../../../src/security/secret-envelope.js";
import cryptos from "../../../src/storage/cryptos.json" with { type: "json" };
import { rentExempt, startValidator, validatorMissing, type SolanaValidator } from "./validator.js";

// Spec seam 3 for Solana: the real SOL and SPL token adapters pay out from a
// deposit on a throwaway solana-test-validator (Agave). Never mainnet. The
// test mints sit at the real USDT/USDC mint addresses, with 6 decimals and a
// mint authority the test holds. Every amount is read back from the node.
//
// The validator's recent priority fees are 0, so the adapters pay the floor
// of 50,000 micro-lamports per compute unit: a SOL payout (1 signature,
// 1,500 compute units) costs 5,000 + 75 lamports, and a token payout
// (2 signatures, 100,000 compute units) 10,000 + 5,000 lamports, plus the
// rent of every token account it creates.

const skipReason = validatorMissing();
if (skipReason !== undefined) console.warn(skipReason);

const FIVE_PERCENT = parseFeeRate("0.05")!;
const SOL_FEE = 5_075n;
const TOKEN_FEE = 15_000n;
const SOL_USD = "150";
const LAMPORTS_PER_SOL = 1_000_000_000n;

const USDT = { asset: "usdtsol", address: cryptos.usdtsol.mint_address, decimals: cryptos.usdtsol.decimal } as const;
const USDC = { asset: "usdcsol", address: cryptos.usdcsol.mint_address, decimals: cryptos.usdcsol.decimal } as const;
const ONE_TOKEN = 10n ** BigInt(USDT.decimals);

function show(result: PayoutResult): string {
  return JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

const newAddress = async () => (await generateKeyPairSigner()).address as string;

/** A gas wallet key in the form the server config holds it. */
async function newGasWallet(): Promise<{ address: string; sealed: SealedSecret }> {
  const seed = new Uint8Array(randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const keyPair = new Uint8Array(64);
  keyPair.set(seed, 0);
  keyPair.set(getAddressEncoder().encode(signer.address), 32);
  return { address: signer.address, sealed: sealSecret("solana-gas-wallet-key", getBase58Decoder().decode(keyPair)) };
}

/**
 * Passes every call through, and records each signed transaction sent. `hideStatusReads` answers "not found" to that many
 * status lookups, and `heightAheadBlocks` moves the finalized height forward: together, a load-balanced provider whose
 * node answering the status is behind the one answering the height.
 */
function countingRpc(inner: SolanaRpc) {
  const sent: string[] = [];
  const state = { hideStatusReads: 0, heightAheadBlocks: 0 };
  const rpc: SolanaRpc = {
    call: async (method, params) => {
      if (method === "sendTransaction") sent.push(String(params[0]));
      if (method === "getSignatureStatuses" && state.hideStatusReads > 0) {
        state.hideStatusReads -= 1;
        return { context: { slot: 0 }, value: [null] };
      }
      const reply = await inner.call(method, params);
      if (method === "getBlockHeight" && typeof reply === "number") return reply + state.heightAheadBlocks;
      return reply;
    },
  };
  return { rpc, sent, state };
}

/** The gas wallet's spend in token units at the test prices (token = $1), rounded up. */
const reimbursement = (lamports: bigint) => ceilDivide(lamports * BigInt(SOL_USD) * ONE_TOKEN, LAMPORTS_PER_SOL);

describe("Solana payouts on a local solana-test-validator", { skip: skipReason }, () => {
  let node: SolanaValidator;
  let rpc: ReturnType<typeof countingRpc>;
  let platform: string;
  let gasWallet: { address: string; sealed: SealedSecret };
  let native: ChainAdapter;
  let token: ChainAdapter;
  let prices: Record<string, string | undefined>;
  let rentMin: bigint;
  let tokenRent: bigint;

  before(async () => {
    node = await startValidator({ mints: [USDT, USDC] });
    rpc = countingRpc(node.client);
    rentMin = await rentExempt(node, 0);
    tokenRent = await rentExempt(node, 165);
  });

  after(async () => {
    await node?.stop();
  });

  /** Fresh platform and gas wallets, so balances start at 0. */
  async function freshAdapters(options: { gasWalletKey?: boolean; lostMarginBlocks?: number } = {}) {
    platform = await newAddress();
    gasWallet = await newGasWallet();
    await node.airdrop(gasWallet.address, LAMPORTS_PER_SOL);
    prices = { sol: SOL_USD, [USDT.asset]: "1" };
    const margin = options.lostMarginBlocks === undefined ? {} : { lostMarginBlocks: options.lostMarginBlocks };
    native = createSolAdapter({ rpc: rpc.rpc, platformAddress: platform, ...margin });
    token = createSplTokenAdapter({
      ...margin,
      rpc: rpc.rpc,
      asset: USDT.asset,
      platformAddress: platform,
      gasWalletKey: options.gasWalletKey === false ? undefined : gasWallet.sealed,
      getPrice: async (asset) => prices[asset],
    });
  }

  /** A deposit holding `amount` (lamports, or token units), and a request builder. */
  async function fundedDeposit(adapter: ChainAdapter, amount: bigint, fields: Partial<PayoutRequest> = {}) {
    const deposit = await adapter.newDeposit();
    if (adapter === native) await node.pay(deposit.address, amount);
    else await node.payToken(USDT, deposit.address, amount);
    const saved: PayoutCheckpoint[] = [];
    const fixed: PayoutRequest = {
      depositAddress: deposit.address,
      depositKey: deposit.key,
      destination: await newAddress(),
      destinationKind: "merchant_payout",
      receiveAsset: adapter.asset,
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

  /** Calls payout until it is paid: each payout waits until its transaction is finalized. */
  async function payUntilPaid(adapter: ChainAdapter, request: () => PayoutRequest): Promise<PayoutResult & { status: "paid" }> {
    const started = Date.now();
    for (;;) {
      const result = await adapter.payout(request());
      if (result.status === "paid") return result;
      assert.equal(result.status, "pending", show(result));
      if (Date.now() - started > 60_000) assert.fail(`not paid after 60 s: ${show(result)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const tokens = (owner: string) => node.tokenBalance(USDT.address, owner);
  const distinct = (wires: string[]) => new Set(wires).size;

  // ---------- Payments ----------

  it("lists a SOL payment with its signature, amount, block time, and 1 confirmation once finalized", async () => {
    await freshAdapters();
    const deposit = await native.newDeposit();
    const txid = await node.pay(deposit.address, 2_000_000n);

    const payments = await native.getPayments(deposit.address);

    assert.deepEqual(payments?.map((p) => [p.txid, p.amount, p.confirmations]), [[txid, 2_000_000n, 1]]);
    assert.ok(payments![0]!.seenAt! > Date.now() - 3_600_000);
  });

  it("counts a SOL payment as confirmed only once it is finalized", async () => {
    await freshAdapters();
    const deposit = await native.newDeposit();
    const sent = node.pay(deposit.address, 3_000_000n);

    let first: Awaited<ReturnType<ChainAdapter["getPayments"]>>;
    await node.waitFor(async () => {
      first = await native.getPayments(deposit.address);
      return (first?.length ?? 0) > 0;
    }, "the payment to be listed");
    await sent;

    assert.equal(first![0]!.confirmations, 0, "listed before it was finalized");
    assert.equal((await native.getPayments(deposit.address))![0]!.confirmations, 1);
  });

  it("lists a token payment into the deposit's token account, and not SOL or another owner's tokens", async () => {
    await freshAdapters();
    const deposit = await token.newDeposit();
    const txid = await node.payToken(USDT, deposit.address, 7n * ONE_TOKEN);
    await node.pay(deposit.address, 1_000_000n);
    await node.payToken(USDT, await newAddress(), 5n);
    await node.payToken(USDC, deposit.address, 9n);

    const payments = await token.getPayments(deposit.address);

    assert.deepEqual(payments?.map((p) => [p.txid, p.amount, p.confirmations]), [[txid, 7n * ONE_TOKEN, 1]]);
    assert.deepEqual(await createSplTokenAdapter({ rpc: rpc.rpc, asset: "usdtsol", platformAddress: platform, gasWalletKey: undefined, getPrice: async () => undefined }).getPayments(await newAddress()), []);
  });

  it("does not count a SOL payout from the deposit as a payment", async () => {
    await freshAdapters();
    const d = await fundedDeposit(native, LAMPORTS_PER_SOL);
    await payUntilPaid(native, d.request);

    const payments = await native.getPayments(d.deposit.address);

    assert.deepEqual(payments?.map((p) => p.amount), [LAMPORTS_PER_SOL]);
  });

  // ---------- SOL ----------

  it("pays SOL at 5%: exact shares to merchant and platform, the deposit emptied", async () => {
    await freshAdapters();
    const received = LAMPORTS_PER_SOL;
    const d = await fundedDeposit(native, received);
    const platformFee = received / 20n;

    const result = await payUntilPaid(native, d.request);

    assert.equal(d.saved.length, 1);
    assert.equal(d.saved[0]!.plan.networkCost, SOL_FEE);
    assert.equal(d.saved[0]!.plan.platformFee, platformFee);
    assert.deepEqual(
      result.transfers.map((t) => [t.kind, t.to, t.amount]),
      [
        ["merchant_payout", d.destination, received - platformFee - SOL_FEE],
        ["platform_fee", platform, platformFee],
      ],
    );
    assert.equal(await node.balance(d.destination), received - platformFee - SOL_FEE);
    assert.equal(await node.balance(platform), platformFee);
    assert.equal(await node.balance(d.deposit.address), 0n, "the real fee equals the planned network cost");
  });

  it("pays SOL at 0%: one transfer, the merchant gets all but the fee", async () => {
    await freshAdapters();
    const received = LAMPORTS_PER_SOL / 10n;
    const d = await fundedDeposit(native, received, { feeRate: 0n });

    const result = await payUntilPaid(native, d.request);

    assert.deepEqual(result.transfers.map((t) => [t.kind, t.amount]), [["merchant_payout", received - SOL_FEE]]);
    assert.equal(await node.balance(d.destination), received - SOL_FEE);
    assert.equal(await node.balance(platform), 0n);
    assert.equal(await node.balance(d.deposit.address), 0n);
  });

  it("charges SOL's fee only on the part that has not paid it yet (a refunded swap's money)", async () => {
    await freshAdapters();
    const received = LAMPORTS_PER_SOL;
    const exempt = (received * 3n) / 5n;
    const d = await fundedDeposit(native, received, { destinationKind: "refund_route", feeExempt: exempt });
    const platformFee = (received - exempt) / 20n;

    const result = await payUntilPaid(native, d.request);

    assert.deepEqual(result.transfers.map((t) => [t.kind, t.amount]), [
      ["refund_route", received - platformFee - SOL_FEE],
      ["platform_fee", platformFee],
    ]);
    assert.equal(await node.balance(platform), platformFee);
    assert.equal(await node.balance(d.deposit.address), 0n);
  });

  it("gives the merchant a platform fee too small to open the empty platform wallet (rent)", async () => {
    await freshAdapters();
    const received = 2_000_000n;
    assert.ok(received / 20n < rentMin);
    const d = await fundedDeposit(native, received);

    const result = await payUntilPaid(native, d.request);

    assert.deepEqual(result.transfers.map((t) => [t.kind, t.amount]), [["merchant_payout", received - SOL_FEE]]);
    assert.equal(d.saved[0]!.plan.platformFee, 0n);
    assert.equal(await node.balance(platform), 0n);
    assert.equal(await node.balance(d.deposit.address), 0n);
  });

  it("says too small to forward, and sends nothing, when the merchant's share can't open an empty wallet (rent)", async () => {
    await freshAdapters();
    const received = rentMin + 1_000n;
    const d = await fundedDeposit(native, received);
    const sentBefore = rpc.sent.length;

    const result = await native.payout(d.request());

    assert.equal(result.status, "too_small", show(result));
    assert.equal(d.saved.length, 0);
    assert.equal(rpc.sent.length, sentBefore);
    assert.equal(await node.balance(d.deposit.address), received);
  });

  it("routes late SOL after the merchant payout, without paying the merchant again", async () => {
    await freshAdapters();
    const d = await fundedDeposit(native, LAMPORTS_PER_SOL);
    await payUntilPaid(native, d.request);
    const merchantBefore = await node.balance(d.destination);
    const platformBefore = await node.balance(platform);

    const late = 3n * 10n ** 7n;
    await node.pay(d.deposit.address, late);
    const refundAddress = await newAddress();
    const routeSaved: PayoutCheckpoint[] = [];
    const route = (): PayoutRequest => ({
      ...d.request(undefined),
      destination: refundAddress,
      destinationKind: "refund_route",
      minimumAmount: 1n,
      checkpoint: routeSaved.at(-1),
      saveCheckpoint: async (next) => {
        routeSaved.push(next);
        return true;
      },
    });

    const result = await payUntilPaid(native, route);

    const fee = late / 20n;
    assert.deepEqual(
      result.transfers.map((t) => [t.kind, t.to, t.amount]),
      [
        ["refund_route", refundAddress, late - fee - SOL_FEE],
        ["platform_fee", platform, fee],
      ],
    );
    assert.equal(await node.balance(refundAddress), late - fee - SOL_FEE);
    assert.equal(await node.balance(platform), platformBefore + fee);
    assert.equal(await node.balance(d.destination), merchantBefore, "the merchant was not paid again");
    assert.equal(await node.balance(d.deposit.address), 0n);
  });

  it("after a crash right after the checkpoint, sends the saved SOL payout and never another", async () => {
    await freshAdapters();
    const saved: PayoutCheckpoint[] = [];
    const d = await fundedDeposit(native, LAMPORTS_PER_SOL, {
      saveCheckpoint: async (next) => {
        saved.push(next);
        throw new Error("process killed after the save");
      },
    });
    const sentBefore = rpc.sent.length;
    const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });

    await assert.rejects(native.payout(d.request(undefined)), /process killed/);
    assert.equal(rpc.sent.length, sentBefore, "nothing was broadcast before the crash");

    const paid = await payUntilPaid(native, again);
    const sentWhilePaying = rpc.sent.length;
    const paidAgain = await native.payout(again());

    assert.deepEqual(paidAgain, paid);
    assert.equal(rpc.sent.length, sentWhilePaying, "a call after paid sends nothing");
    assert.equal(distinct(rpc.sent.slice(sentBefore)), 1, "only the saved transaction was ever sent");
    assert.equal(saved.length, 1, "nothing new was built");
    assert.equal(paid.transfers[0]!.txid, saved[0]!.plan.transfers[0]!.txid);
    assert.equal(await node.balance(d.destination), LAMPORTS_PER_SOL - LAMPORTS_PER_SOL / 20n - SOL_FEE);
  });

  it("sends nothing when another run saved first", async () => {
    await freshAdapters();
    const d = await fundedDeposit(native, LAMPORTS_PER_SOL, { saveCheckpoint: async () => false });
    const sentBefore = rpc.sent.length;

    const result = await native.payout(d.request(undefined));

    assert.equal(result.status, "pending");
    assert.equal(rpc.sent.length, sentBefore);
  });

  it("rebuilds a saved payout whose blockhash expired unsent, saving the new one before sending it", async () => {
    await freshAdapters({ lostMarginBlocks: 5 });
    const saved: PayoutCheckpoint[] = [];
    let crash = true;
    const d = await fundedDeposit(native, LAMPORTS_PER_SOL, {
      saveCheckpoint: async (next) => {
        saved.push(next);
        if (crash) throw new Error("process killed after the save");
        return true;
      },
    });
    const sentBefore = rpc.sent.length;
    const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });

    await assert.rejects(native.payout(d.request(undefined)), /process killed/);
    const lost = saved[0]!.plan.transfers[0]!.txid;
    const lastValid = BigInt(JSON.parse(saved[0]!.state).lastValidBlockHeight);
    await node.waitFor(
      async () => BigInt(await node.rpc<number>("getBlockHeight", [{ commitment: "finalized" }])) > lastValid + 5n,
      "the saved blockhash to expire, plus the margin",
      60_000,
    );

    // The rebuild is saved, then the process dies before it is sent.
    await assert.rejects(native.payout(again()), /process killed/);
    assert.equal(saved.length, 2);
    assert.equal(rpc.sent.length, sentBefore, "nothing was broadcast before the second save");

    crash = false;
    const paid = await payUntilPaid(native, again);

    assert.equal(paid.transfers[0]!.txid, saved[1]!.plan.transfers[0]!.txid, "the proof names the rebuilt transaction");
    assert.notEqual(paid.transfers[0]!.txid, lost);
    assert.equal(distinct(rpc.sent.slice(sentBefore)), 1, "the expired transaction was never sent");
    assert.equal(await node.rpc("getSignatureStatuses", [[lost], { searchTransactionHistory: true }]).then((s) => s.value[0]), null);
    assert.equal(await node.balance(d.destination), LAMPORTS_PER_SOL - LAMPORTS_PER_SOL / 20n - SOL_FEE);
  });

  describe("a saved payout a lagging node can't find, while the finalized height is past its last valid height", () => {
    const MARGIN = 150;
    const finalizedHeight = async () => BigInt(await node.rpc<number>("getBlockHeight", [{ commitment: "finalized" }]));

    it("waits, and never rebuilds, within the margin past the last valid height", async () => {
      await freshAdapters({ lostMarginBlocks: MARGIN });
      const saved: PayoutCheckpoint[] = [];
      const d = await fundedDeposit(native, LAMPORTS_PER_SOL, {
        saveCheckpoint: async (next) => {
          saved.push(next);
          throw new Error("process killed after the save");
        },
      });
      const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });
      await assert.rejects(native.payout(d.request(undefined)), /process killed/);
      const lastValid = BigInt(JSON.parse(saved[0]!.state).lastValidBlockHeight);
      const sentBefore = rpc.sent.length;

      rpc.state.hideStatusReads = 1_000;
      rpc.state.heightAheadBlocks = Number(lastValid - (await finalizedHeight())) + 1;
      try {
        const raced = await native.payout(again());
        assert.equal(raced.status, "pending", show(raced));
      } finally {
        rpc.state.hideStatusReads = 0;
        rpc.state.heightAheadBlocks = 0;
      }
      assert.equal(saved.length, 1, "nothing rebuilt");
      assert.equal(rpc.sent.length, sentBefore, "nothing sent");

      const paid = await payUntilPaid(native, again);
      assert.equal(paid.transfers[0]!.txid, saved[0]!.plan.transfers[0]!.txid);
    });

    it("past the margin, looks the status up again and proves the landed payout instead of rebuilding", async () => {
      await freshAdapters({ lostMarginBlocks: MARGIN });
      const d = await fundedDeposit(native, LAMPORTS_PER_SOL);
      const paid = await payUntilPaid(native, d.request);
      const lastValid = BigInt(JSON.parse(d.saved[0]!.state).lastValidBlockHeight);
      const sentBefore = rpc.sent.length;

      rpc.state.hideStatusReads = 1;
      rpc.state.heightAheadBlocks = Number(lastValid - (await finalizedHeight())) + MARGIN + 10;
      let again: PayoutResult;
      try {
        again = await native.payout(d.request());
      } finally {
        rpc.state.hideStatusReads = 0;
        rpc.state.heightAheadBlocks = 0;
      }
      assert.deepEqual(again, paid);
      assert.equal(d.saved.length, 1, "nothing rebuilt");
      assert.equal(rpc.sent.length, sentBefore, "nothing sent");
    });
  });

  it("pays a payer-pays SOL invoice paid exactly: the merchant receives exactly the invoice amount", async () => {
    await freshAdapters();
    const invoiceAmount = LAMPORTS_PER_SOL / 2n;
    const estimate = await native.estimateNetworkCost();
    assert.equal(estimate, SOL_FEE);
    const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost: estimate!, feeRate: FIVE_PERCENT });
    const d = await fundedDeposit(native, asked);

    await payUntilPaid(native, d.request);

    assert.equal(await node.balance(d.destination), invoiceAmount);
    assert.equal(await node.balance(platform), asked - invoiceAmount - estimate!);
  });

  it("fails with a where-the-money-is message, sending nothing, when the destination is not a wallet", async () => {
    await freshAdapters();
    const d = await fundedDeposit(native, LAMPORTS_PER_SOL, { destination: USDT.address });
    const sentBefore = rpc.sent.length;

    const result = await native.payout(d.request());

    assert.equal(result.status, "failed", show(result));
    assert.match((result as { message: string }).message, new RegExp(`still at deposit address ${d.deposit.address}`));
    assert.equal(rpc.sent.length, sentBefore);
  });

  // ---------- SPL tokens ----------

  /** A token payout's expected amounts, given how many token accounts it must create. */
  function expectedTokenPayout(received: bigint, feeRate: bigint, accountsCreated: bigint) {
    const gasSpend = TOKEN_FEE + accountsCreated * tokenRent;
    const reimbursed = reimbursement(gasSpend);
    const fee = ceilDivide(received * feeRate, 10n ** 8n);
    return { gasSpend, reimbursed, fee, merchant: received - fee - reimbursed, platform: fee + reimbursed };
  }

  it("pays a token at 5%, creating both token accounts: exact shares, the gas wallet's SOL reimbursed in tokens", async () => {
    await freshAdapters();
    const received = 1_000n * ONE_TOKEN;
    const d = await fundedDeposit(token, received);
    const gasBefore = await node.balance(gasWallet.address);
    const want = expectedTokenPayout(received, FIVE_PERCENT, 2n);

    const result = await payUntilPaid(token, d.request);

    assert.deepEqual(
      result.transfers.map((t) => [t.kind, t.to, t.amount]),
      [
        ["gas_top_up", d.deposit.address, want.gasSpend],
        ["merchant_payout", d.destination, want.merchant],
        ["platform_fee", platform, want.platform],
      ],
    );
    const plan = d.saved.at(-1)!.plan;
    assert.equal(plan.platformFee, want.fee);
    assert.equal(plan.networkCost, want.reimbursed);
    assert.equal(await tokens(d.destination), want.merchant);
    assert.equal(await tokens(platform), want.platform);
    assert.equal(await tokens(d.deposit.address), 0n);
    assert.equal(gasBefore - (await node.balance(gasWallet.address)), want.gasSpend, "the gas wallet spent exactly the recorded gas_top_up");
    assert.equal(await node.balance(d.deposit.address), 0n, "the deposit wallet holds no SOL");
  });

  it("pays a token at 0%: the platform transfer carries only the gas reimbursement", async () => {
    await freshAdapters();
    const received = 50n * ONE_TOKEN;
    const d = await fundedDeposit(token, received, { feeRate: 0n });
    const want = expectedTokenPayout(received, 0n, 2n);

    const result = await payUntilPaid(token, d.request);

    assert.deepEqual(
      result.transfers.map((t) => [t.kind, t.amount]),
      [
        ["gas_top_up", want.gasSpend],
        ["merchant_payout", received - want.reimbursed],
        ["platform_fee", want.reimbursed],
      ],
    );
    assert.equal(await tokens(d.destination), received - want.reimbursed);
    assert.equal(await tokens(platform), want.reimbursed);
  });

  it("charges a token's fee only on the part that has not paid it yet; the gas is still reimbursed", async () => {
    await freshAdapters();
    const received = 1_000n * ONE_TOKEN;
    const exempt = 600n * ONE_TOKEN;
    const d = await fundedDeposit(token, received, { destinationKind: "refund_route", feeExempt: exempt });
    const want = expectedTokenPayout(received - exempt, FIVE_PERCENT, 2n);

    const result = await payUntilPaid(token, d.request);

    assert.deepEqual(
      result.transfers.map((t) => [t.kind, t.amount]),
      [
        ["gas_top_up", want.gasSpend],
        ["refund_route", received - want.fee - want.reimbursed],
        ["platform_fee", want.fee + want.reimbursed],
      ],
    );
    assert.equal(d.saved.at(-1)!.plan.platformFee, want.fee);
    assert.equal(await tokens(platform), want.fee + want.reimbursed);
  });

  it("routes late token money after the merchant payout, paying rent only for the new refund account", async () => {
    await freshAdapters();
    const d = await fundedDeposit(token, 1_000n * ONE_TOKEN);
    await payUntilPaid(token, d.request);
    const merchantBefore = await tokens(d.destination);
    const platformBefore = await tokens(platform);

    const late = 40n * ONE_TOKEN;
    await node.payToken(USDT, d.deposit.address, late);
    const refundAddress = await newAddress();
    const routeSaved: PayoutCheckpoint[] = [];
    const route = (): PayoutRequest => ({
      ...d.request(undefined),
      destination: refundAddress,
      destinationKind: "refund_route",
      minimumAmount: 1n,
      checkpoint: routeSaved.at(-1),
      saveCheckpoint: async (next) => {
        routeSaved.push(next);
        return true;
      },
    });
    const gasBefore = await node.balance(gasWallet.address);

    const result = await payUntilPaid(token, route);

    const want = expectedTokenPayout(late, FIVE_PERCENT, 1n);
    assert.deepEqual(
      result.transfers.map((t) => [t.kind, t.to, t.amount]),
      [
        ["gas_top_up", d.deposit.address, want.gasSpend],
        ["refund_route", refundAddress, want.merchant],
        ["platform_fee", platform, want.platform],
      ],
    );
    assert.equal(await tokens(refundAddress), want.merchant);
    assert.equal(await tokens(platform), platformBefore + want.platform);
    assert.equal(await tokens(d.destination), merchantBefore, "the merchant was not paid again");
    assert.equal(await tokens(d.deposit.address), 0n);
    assert.equal(gasBefore - (await node.balance(gasWallet.address)), want.gasSpend);
  });

  it("after a crash right after the checkpoint, sends the saved token payout once and never again", async () => {
    await freshAdapters();
    const saved: PayoutCheckpoint[] = [];
    const d = await fundedDeposit(token, 100n * ONE_TOKEN, {
      saveCheckpoint: async (next) => {
        saved.push(next);
        throw new Error("process killed after the save");
      },
    });
    const sentBefore = rpc.sent.length;
    const gasBefore = await node.balance(gasWallet.address);
    const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });

    await assert.rejects(token.payout(d.request(undefined)), /process killed/);
    assert.equal(rpc.sent.length, sentBefore, "nothing was broadcast before the crash");
    assert.equal(await node.balance(gasWallet.address), gasBefore);

    const paid = await payUntilPaid(token, again);
    const sentWhilePaying = rpc.sent.length;
    const paidAgain = await token.payout(again());

    assert.deepEqual(paidAgain, paid);
    assert.equal(rpc.sent.length, sentWhilePaying, "a call after paid sends nothing");
    assert.equal(distinct(rpc.sent.slice(sentBefore)), 1);
    assert.equal(saved.length, 1);
    const want = expectedTokenPayout(100n * ONE_TOKEN, FIVE_PERCENT, 2n);
    assert.equal(await tokens(d.destination), want.merchant);
    assert.equal(gasBefore - (await node.balance(gasWallet.address)), want.gasSpend, "the gas wallet paid once");
  });

  it("says too small to forward, and sends nothing, when the fee and the rent of the new token accounts would eat a token deposit", async () => {
    await freshAdapters();
    const want = expectedTokenPayout(ONE_TOKEN, FIVE_PERCENT, 2n);
    const tooSmall = want.reimbursed;
    const d = await fundedDeposit(token, tooSmall);
    const sentBefore = rpc.sent.length;
    const gasBefore = await node.balance(gasWallet.address);

    const result = await token.payout(d.request());

    assert.equal(result.status, "too_small", show(result));
    assert.equal(d.saved.length, 0);
    assert.equal(rpc.sent.length, sentBefore);
    assert.equal(await node.balance(gasWallet.address), gasBefore);
    assert.equal(await tokens(d.deposit.address), tooSmall);
  });

  it("pays a payer-pays token invoice paid exactly to a merchant who holds the token: exactly the invoice amount", async () => {
    await freshAdapters();
    const invoiceAmount = 250n * ONE_TOKEN;
    const estimate = await token.estimateNetworkCost();
    assert.equal(estimate, reimbursement(TOKEN_FEE));
    const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost: estimate!, feeRate: FIVE_PERCENT });
    const d = await fundedDeposit(token, asked);
    await node.createTokenAccount(USDT, d.destination);
    await node.createTokenAccount(USDT, platform);

    await payUntilPaid(token, d.request);

    assert.equal(await tokens(d.destination), invoiceAmount);
    assert.equal(await tokens(platform), asked - invoiceAmount);
  });

  it("waits with a review note, sending nothing, when the gas wallet key is missing", async () => {
    await freshAdapters({ gasWalletKey: false });
    const d = await fundedDeposit(token, 10n * ONE_TOKEN);
    const sentBefore = rpc.sent.length;

    const result = await token.payout(d.request());

    assert.equal(result.status, "pending", show(result));
    assert.match((result as { review?: string }).review ?? "", /gas wallet key is not configured/);
    assert.match((result as { review?: string }).review ?? "", new RegExp(d.deposit.address));
    assert.equal(d.saved.length, 0);
    assert.equal(rpc.sent.length, sentBefore);
    assert.equal((await token.getPayments(d.deposit.address))?.length, 1, "payments are still detected");
  });

  it("waits, sending nothing, when no price converts the gas cost", async () => {
    await freshAdapters();
    prices.sol = undefined;
    const d = await fundedDeposit(token, 10n * ONE_TOKEN);
    const sentBefore = rpc.sent.length;

    const result = await token.payout(d.request());

    assert.equal(result.status, "pending", show(result));
    assert.equal(d.saved.length, 0);
    assert.equal(rpc.sent.length, sentBefore);
    assert.equal(await token.estimateNetworkCost(), undefined);
  });

  it("fails with a where-the-money-is message when the destination is a token account, not a wallet", async () => {
    await freshAdapters();
    const merchantWallet = await newAddress();
    await node.createTokenAccount(USDT, merchantWallet);
    const d = await fundedDeposit(token, 10n * ONE_TOKEN, { destination: await node.ataOf(merchantWallet, USDT.address) });
    const sentBefore = rpc.sent.length;

    const result = await token.payout(d.request());

    assert.equal(result.status, "failed", show(result));
    assert.match((result as { message: string }).message, new RegExp(`still at deposit address ${d.deposit.address}`));
    assert.equal(rpc.sent.length, sentBefore);
  });
});
