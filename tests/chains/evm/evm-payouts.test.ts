import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { AbiCoder, id, Wallet } from "ethers";

import type { ChainAdapter, PayoutCheckpoint, PayoutRequest, PayoutResult } from "../../../src/chains/adapter.js";
import type { EvmRpc } from "../../../src/chains/evm-rpc.js";
import { createEvmNativeAdapter, createEvmTokenAdapter, EVM_CHAINS } from "../../../src/chains/evm.js";
import { parseFeeRate, payerPaysAskedAmount } from "../../../src/money/payout-split.js";
import { ceilDivide } from "../../../src/money/format.js";
import { sealSecret, type SecretPurpose } from "../../../src/security/secret-envelope.js";
import cryptos from "../../../src/storage/cryptos.json" with { type: "json" };
import { PAYER_PAYS_TOKEN_TRANSFER_GAS, TOKEN_AMOUNT_CALLDATA_SLACK, TOKEN_GAS_MARGIN } from "../../../src/transactions/evm.js";
import { blockbookShim, dockerUnavailable, NODE_GAS_PRICE, startAnvil, type AnvilNode } from "./anvil.js";

// Spec seam 3 for the EVM chains: the real native and token adapters pay out
// from a deposit on a throwaway anvil node (Docker), chain id 1 for Ethereum
// and 56 for BNB Smart Chain. Never mainnet. The token is a test ERC-20 put
// at the real contract address with anvil_setCode. Every amount is read
// back from the node.
//
// The suggested gas price is pinned at 1 gwei at the RPC wrapper (anvil's
// own suggestion follows what recent transactions paid, so it drifts within
// a run); the node accepts it because its base fee is 0. With no base fee to
// rise, the adapter pays exactly the suggestion. A native transfer uses
// 21,000 gas; each token transfer gets the node's eth_estimateGas plus
// TOKEN_GAS_MARGIN, and the merchant is charged the estimate only.

const skipReason = await dockerUnavailable();
if (skipReason !== undefined) console.warn(skipReason);

const FIVE_PERCENT = parseFeeRate("0.05")!;
const GAS_PRICE = NODE_GAS_PRICE;
// What the code before fix ticket F charged per token payout, for the measured comparison.
const OLD_GAS_PRICE = (NODE_GAS_PRICE * 125n) / 100n;
const OLD_TOKEN_CHARGE = OLD_GAS_PRICE * (100_000n * 2n + 21_000n);
const SWEEP_GAS = 21_000n;
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
const transferData = (to: string, amount: bigint) =>
  id("transfer(address,uint256)").slice(0, 10) + AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [to, amount]).slice(2);

const CHAINS = [
  {
    name: "eth",
    chainId: 1,
    native: "eth",
    token: "usdteth",
    // Ethereum USDT's transfer returns nothing; the test token copies that.
    noReturn: true,
    nativeUsd: "3000",
    gasPurpose: "ethereum-gas-wallet-key",
  },
  {
    name: "bsc",
    chainId: 56,
    native: "bsc",
    token: "usdtbsc",
    noReturn: false,
    nativeUsd: "600",
    gasPurpose: "bsc-gas-wallet-key",
  },
] as const;

function show(result: PayoutResult): string {
  return JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

const newAddress = () => Wallet.createRandom().address;

/** Passes every call through except the pinned gas price, and counts the broadcasts. */
function countingRpc(inner: EvmRpc) {
  const sent: string[] = [];
  const rpc: EvmRpc = {
    call: async (method, params) => {
      if (method === "eth_gasPrice") return "0x" + NODE_GAS_PRICE.toString(16);
      if (method === "eth_sendRawTransaction") sent.push(String(params[0]));
      return await inner.call(method, params);
    },
  };
  return { rpc, sent };
}

for (const spec of CHAINS) {
  const tokenFacts = cryptos[spec.token];
  const decimals = BigInt(tokenFacts.decimal);
  const oneToken = 10n ** decimals;

  /** The gas wallet's spend in token units at the test prices, rounded up. */
  const reimbursement = (wei: bigint) =>
    ceilDivide(wei * BigInt(spec.nativeUsd) * oneToken, 10n ** 18n);

  describe(`${spec.name.toUpperCase()} payouts on an anvil node (chain id ${spec.chainId})`, { skip: skipReason }, () => {
    let node: AnvilNode;
    let rpc: ReturnType<typeof countingRpc>;
    let platform: string;
    let gasWallet: Wallet;
    let native: ChainAdapter;
    let token: ChainAdapter;
    let prices: Record<string, string | undefined>;

    before(async () => {
      node = await startAnvil(spec.name, spec.chainId);
      rpc = countingRpc(node.client);
      await node.installToken(tokenFacts.contract_address, tokenFacts.decimal, spec.noReturn);
    });

    after(async () => {
      await node?.stop();
    });

    /** Fresh platform and gas wallets, so balances start at 0. */
    async function freshAdapters(options: { gasWalletKey?: boolean } = {}) {
      platform = newAddress();
      gasWallet = Wallet.createRandom() as unknown as Wallet;
      await node.setBalance(gasWallet.address, 10n ** 18n);
      prices = { [spec.native]: spec.nativeUsd, [spec.token]: "1" };
      const clients = { rpc: rpc.rpc, index: blockbookShim(node) };
      native = createEvmNativeAdapter({ ...clients, chain: spec.name, platformAddress: platform });
      token = createEvmTokenAdapter({
        ...clients,
        chain: spec.name,
        asset: spec.token,
        platformAddress: platform,
        gasWalletKey:
          options.gasWalletKey === false ? undefined : sealSecret(spec.gasPurpose as SecretPurpose, gasWallet.privateKey),
        getPrice: async (asset) => prices[asset],
      });
    }

    /** A deposit holding `amount` (native coin, or the token), and a request builder. */
    async function fundedDeposit(adapter: ChainAdapter, amount: bigint, fields: Partial<PayoutRequest> = {}) {
      const deposit = await adapter.newDeposit();
      if (adapter === native) await node.pay(deposit.address, amount);
      else await node.payToken(tokenFacts.contract_address, deposit.address, amount);
      const saved: PayoutCheckpoint[] = [];
      const fixed: PayoutRequest = {
        depositAddress: deposit.address,
        depositKey: deposit.key,
        destination: newAddress(),
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

    /** Calls payout until it is paid (anvil mines each broadcast at once). */
    async function payUntilPaid(adapter: ChainAdapter, request: () => PayoutRequest): Promise<PayoutResult & { status: "paid" }> {
      for (let round = 0; round < 5; round += 1) {
        const result = await adapter.payout(request());
        if (result.status === "paid") return result;
        assert.equal(result.status, "pending", show(result));
      }
      assert.fail("not paid after 5 rounds");
    }

    const tokens = (owner: string) => node.tokenBalance(tokenFacts.contract_address, owner);

    // ---------- Payments ----------

    it("lists a native payment with its amount, confirmations and block time", async () => {
      await freshAdapters();
      const deposit = await native.newDeposit();
      const txid = await node.pay(deposit.address, 123_456n);
      await node.mine(2);

      const payments = await native.getPayments(deposit.address);

      assert.deepEqual(payments?.map((p) => [p.txid, p.amount, p.confirmations]), [[txid, 123_456n, 3]]);
      assert.ok(payments![0]!.seenAt! > Date.now() - 3_600_000);
    });

    it("lists a token payment from its Transfer log, and not the native coin or another address's transfer", async () => {
      await freshAdapters();
      const deposit = await token.newDeposit();
      const txid = await node.payToken(tokenFacts.contract_address, deposit.address, 7n * oneToken);
      await node.pay(deposit.address, 1_000n);
      await node.payToken(tokenFacts.contract_address, newAddress(), 5n);

      const payments = await token.getPayments(deposit.address);

      assert.deepEqual(payments?.map((p) => [p.txid, p.amount, p.confirmations]), [[txid, 7n * oneToken, 4]]);
    });

    // ---------- Native coin ----------

    it("pays the native coin at 5%: exact shares to merchant and platform, the deposit emptied", async () => {
      await freshAdapters();
      const received = 10n ** 18n;
      const d = await fundedDeposit(native, received);
      const cost = GAS_PRICE * 21_000n * 2n;
      const platformFee = received / 20n;

      const result = await payUntilPaid(native, d.request);

      assert.equal(d.saved.length, 1);
      assert.equal(d.saved[0]!.plan.networkCost, cost);
      assert.deepEqual(
        result.transfers.map((t) => [t.kind, t.to, t.amount]),
        [
          ["merchant_payout", d.destination, received - platformFee - cost],
          ["platform_fee", platform, platformFee],
        ],
      );
      assert.equal(await node.balance(d.destination), received - platformFee - cost);
      assert.equal(await node.balance(platform), platformFee);
      assert.equal(await node.balance(d.deposit.address), 0n, "the real gas equals the planned network cost");
    });

    it("pays the native coin at 0%: one transfer, the merchant gets all but its gas", async () => {
      await freshAdapters();
      const received = 10n ** 17n;
      const d = await fundedDeposit(native, received, { feeRate: 0n });

      const result = await payUntilPaid(native, d.request);

      assert.deepEqual(result.transfers.map((t) => [t.kind, t.amount]), [["merchant_payout", received - GAS_PRICE * 21_000n]]);
      assert.equal(await node.balance(platform), 0n);
      assert.equal(await node.balance(d.deposit.address), 0n);
    });

    it("routes native money that already paid its fee as one transfer: no platform transfer and one transfer's gas", async () => {
      await freshAdapters();
      const received = 10n ** 17n;
      const d = await fundedDeposit(native, received, { destinationKind: "refund_route", feeExempt: received });

      const result = await payUntilPaid(native, d.request);

      assert.deepEqual(result.transfers.map((t) => [t.kind, t.amount]), [["refund_route", received - GAS_PRICE * 21_000n]]);
      assert.equal(await node.balance(platform), 0n);
      assert.equal(await node.balance(d.deposit.address), 0n);
    });

    it("routes late native money after the merchant payout, with nonces from the chain, without paying the merchant again", async () => {
      await freshAdapters();
      const d = await fundedDeposit(native, 10n ** 18n);
      await payUntilPaid(native, d.request);
      const merchantBefore = await node.balance(d.destination);
      const platformBefore = await node.balance(platform);

      const late = 3n * 10n ** 16n;
      await node.pay(d.deposit.address, late);
      const refundAddress = newAddress();
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
      const cost = GAS_PRICE * 21_000n * 2n;
      assert.deepEqual(
        result.transfers.map((t) => [t.kind, t.to, t.amount]),
        [
          ["refund_route", refundAddress, late - fee - cost],
          ["platform_fee", platform, fee],
        ],
      );
      assert.equal(await node.balance(refundAddress), late - fee - cost);
      assert.equal(await node.balance(platform), platformBefore + fee);
      assert.equal(await node.balance(d.destination), merchantBefore, "the merchant was not paid again");
      assert.equal(await node.nonce(d.deposit.address), 4n);
    });

    it("after a crash right after the checkpoint, sends the saved native transfers once and never again", async () => {
      await freshAdapters();
      const saved: PayoutCheckpoint[] = [];
      const d = await fundedDeposit(native, 10n ** 18n, {
        saveCheckpoint: async (next) => {
          saved.push(next);
          throw new Error("process killed after the save");
        },
      });
      const sentBefore = rpc.sent.length;
      const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });

      await assert.rejects(native.payout(d.request(undefined)), /process killed/);
      assert.equal(rpc.sent.length, sentBefore, "nothing was broadcast before the crash");
      assert.equal(await node.nonce(d.deposit.address), 0n);

      const paid = await payUntilPaid(native, again);
      const paidAgain = await native.payout(again());

      assert.deepEqual(paidAgain, paid);
      assert.equal(rpc.sent.length - sentBefore, 2, "each saved transfer was sent once");
      assert.equal(saved.length, 1, "nothing new was built");
      assert.equal(await node.balance(d.destination), 10n ** 18n - 5n * 10n ** 16n - GAS_PRICE * 21_000n * 2n);
    });

    it("sends nothing when another run saved first", async () => {
      await freshAdapters();
      const d = await fundedDeposit(native, 10n ** 18n, { saveCheckpoint: async () => false });
      const sentBefore = rpc.sent.length;

      const result = await native.payout(d.request(undefined));

      assert.equal(result.status, "pending");
      assert.equal(rpc.sent.length, sentBefore);
    });

    it("says too small to forward, and sends nothing, when gas would eat a native deposit", async () => {
      await freshAdapters();
      const tooSmall = GAS_PRICE * 21_000n * 2n;
      const d = await fundedDeposit(native, tooSmall);
      const sentBefore = rpc.sent.length;

      const result = await native.payout(d.request());

      assert.equal(result.status, "too_small", show(result));
      assert.equal(d.saved.length, 0);
      assert.equal(rpc.sent.length, sentBefore);
      assert.equal(await node.balance(d.deposit.address), tooSmall);
    });

    it("pays a payer-pays native invoice paid exactly: the merchant receives exactly the invoice amount", async () => {
      await freshAdapters();
      const invoiceAmount = 5n * 10n ** 17n;
      const estimate = await native.estimateNetworkCost();
      assert.equal(estimate, GAS_PRICE * 21_000n * 2n);
      const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost: estimate!, feeRate: FIVE_PERCENT });
      const d = await fundedDeposit(native, asked);

      await payUntilPaid(native, d.request);

      assert.equal(await node.balance(d.destination), invoiceAmount);
      assert.equal(await node.balance(platform), asked - invoiceAmount - estimate!);
    });

    // ---------- Tokens ----------

    /** The node's own gas estimate for a token transfer from the deposit. */
    const estimateTransfer = async (from: string, to: string, amount: bigint) =>
      BigInt(await node.rpc<string>("eth_estimateGas", [{ from, to: tokenFacts.contract_address, data: transferData(to, amount) }]));

    /**
     * What a token payout is expected to do: the rule of fix ticket F spelled
     * out from the node's own estimates (made before the payout, as the
     * adapter does). `depositGas`: native coin already at the deposit.
     */
    async function expectedTokenPayout(
      d: { deposit: { address: string }; destination: string },
      received: bigint,
      feeRate: bigint,
      depositGas = 0n,
    ) {
      const estimates = [
        await estimateTransfer(d.deposit.address, d.destination, received),
        await estimateTransfer(d.deposit.address, platform, received),
      ];
      const budget = sum(estimates.map((e) => (e + TOKEN_GAS_MARGIN) * GAS_PRICE));
      const topUp = budget > depositGas ? budget - depositGas : 0n;
      const estimated = sum(estimates) * GAS_PRICE;
      const charged = topUp === 0n ? 0n : (estimated > depositGas ? estimated - depositGas : 0n) + GAS_PRICE * SWEEP_GAS;
      const reimbursed = reimbursement(charged);
      const sweepValue = budget - sum(estimates.map((e) => e + TOKEN_AMOUNT_CALLDATA_SLACK)) * GAS_PRICE - GAS_PRICE * SWEEP_GAS;
      const sweep = topUp > 0n && sweepValue > GAS_PRICE * SWEEP_GAS ? sweepValue : 0n;
      const fee = ceilDivide(received * feeRate, 10n ** 8n);
      return { estimates, topUp, charged, reimbursed, sweep, fee, merchant: received - fee - reimbursed, platform: fee + reimbursed };
    }

    it("pays a token at 5%: the merchant charged the estimated gas only, the unused gas swept back to the gas wallet", async (t) => {
      await freshAdapters();
      const received = 1_000n * oneToken;
      const d = await fundedDeposit(token, received);
      const gasBefore = await node.balance(gasWallet.address);
      const want = await expectedTokenPayout(d, received, FIVE_PERCENT);
      assert.ok(want.sweep > 0n, "the margin is worth sweeping");

      const result = await payUntilPaid(token, d.request);

      assert.deepEqual(
        result.transfers.map((t) => [t.kind, t.to, t.amount]),
        [
          ["gas_top_up", d.deposit.address, want.topUp],
          ["merchant_payout", d.destination, want.merchant],
          ["platform_fee", platform, want.platform],
          ["gas_sweep", gasWallet.address, want.sweep],
        ],
      );
      const plan = d.saved.at(-1)!.plan;
      assert.equal(plan.platformFee, want.fee);
      assert.equal(plan.networkCost, want.reimbursed);
      assert.equal(await tokens(d.destination), want.merchant);
      assert.equal(await tokens(platform), want.platform);
      assert.equal(await tokens(d.deposit.address), 0n);

      const [topUpTx, merchantTx, platformTx, sweepTx] = result.transfers.map((t) => t.txid) as [string, string, string, string];
      const topUpGas = await node.gasCost(topUpTx);
      const transfersGas = (await node.gasCost(merchantTx)) + (await node.gasCost(platformTx));
      assert.equal(gasBefore - (await node.balance(gasWallet.address)), want.topUp + topUpGas - want.sweep, "the gas wallet got the sweep back");
      const left = await node.balance(d.deposit.address);
      assert.equal(left, want.topUp - transfersGas - (await node.gasCost(sweepTx)) - want.sweep);
      assert.ok(left < GAS_PRICE * SWEEP_GAS, `the deposit keeps less than a sweep would cost (${left})`);

      // The merchant pays the estimate, never the margin.
      const realSpend = topUpGas + transfersGas;
      assert.ok(want.charged >= realSpend, `charged ${want.charged} covers the real ${realSpend}`);
      assert.ok(want.charged - realSpend <= 2n * TOKEN_GAS_MARGIN * GAS_PRICE);
      t.diagnostic(
        `${spec.name} token payout, wei at 1 gwei: old charge ${OLD_TOKEN_CHARGE}, new charge ${want.charged}, real spend ${realSpend}, swept back ${want.sweep}, left at deposit ${left}`,
      );
    });

    it("pays a token at 0%: the platform transfer carries only the gas reimbursement", async () => {
      await freshAdapters();
      const received = 50n * oneToken;
      const d = await fundedDeposit(token, received, { feeRate: 0n });
      const want = await expectedTokenPayout(d, received, 0n);

      const result = await payUntilPaid(token, d.request);

      assert.deepEqual(
        result.transfers.map((t) => [t.kind, t.amount]),
        [
          ["gas_top_up", want.topUp],
          ["merchant_payout", received - want.reimbursed],
          ["platform_fee", want.reimbursed],
          ["gas_sweep", want.sweep],
        ],
      );
      assert.equal(await tokens(d.destination), received - want.reimbursed);
      assert.equal(await tokens(platform), want.reimbursed);
    });

    it("charges a token's fee only on the part that has not paid it yet; the gas is still reimbursed", async () => {
      await freshAdapters();
      const received = 1_000n * oneToken;
      const exempt = 600n * oneToken;
      const d = await fundedDeposit(token, received, { destinationKind: "refund_route", feeExempt: exempt });
      const want = await expectedTokenPayout(d, received, FIVE_PERCENT);
      const fee = ceilDivide((received - exempt) * FIVE_PERCENT, 10n ** 8n);

      const result = await payUntilPaid(token, d.request);

      assert.deepEqual(
        result.transfers.map((t) => [t.kind, t.amount]),
        [
          ["gas_top_up", want.topUp],
          ["refund_route", received - fee - want.reimbursed],
          ["platform_fee", fee + want.reimbursed],
          ["gas_sweep", want.sweep],
        ],
      );
      assert.equal(d.saved.at(-1)!.plan.platformFee, fee);
      assert.equal(await tokens(platform), fee + want.reimbursed);
    });

    it("routes late token money after the merchant payout, topping up only what the deposit lacks", async () => {
      await freshAdapters();
      const d = await fundedDeposit(token, 1_000n * oneToken);
      await payUntilPaid(token, d.request);
      const merchantBefore = await tokens(d.destination);
      const platformBefore = await tokens(platform);
      const gasLeft = await node.balance(d.deposit.address);

      const late = 40n * oneToken;
      await node.payToken(tokenFacts.contract_address, d.deposit.address, late);
      const refundAddress = newAddress();
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

      const want = await expectedTokenPayout({ deposit: d.deposit, destination: refundAddress }, late, FIVE_PERCENT, gasLeft);
      const result = await payUntilPaid(token, route);

      assert.ok(gasLeft > 0n && gasLeft < GAS_PRICE * SWEEP_GAS, "the first payout left only dust below a sweep's cost");
      assert.deepEqual(
        result.transfers.map((t) => [t.kind, t.to, t.amount]),
        [
          ["gas_top_up", d.deposit.address, want.topUp],
          ["refund_route", refundAddress, want.merchant],
          ["platform_fee", platform, want.platform],
          ["gas_sweep", gasWallet.address, want.sweep],
        ],
      );
      assert.equal(await tokens(refundAddress), want.merchant);
      assert.equal(await tokens(platform), platformBefore + want.platform);
      assert.equal(await tokens(d.destination), merchantBefore, "the merchant was not paid again");
      assert.equal(await tokens(d.deposit.address), 0n);
    });

    it("after a crash after each checkpoint, sends the top-up and each token transfer once", async () => {
      await freshAdapters();
      const saved: PayoutCheckpoint[] = [];
      let crash = true;
      const d = await fundedDeposit(token, 100n * oneToken, {
        saveCheckpoint: async (next) => {
          saved.push(next);
          if (crash) throw new Error("process killed after the save");
          return true;
        },
      });
      const sentBefore = rpc.sent.length;
      const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });
      const gasNonce = await node.nonce(gasWallet.address);
      const want = await expectedTokenPayout(d, 100n * oneToken, FIVE_PERCENT);

      // Checkpoint 1: the top-up, the token transfers and the sweep are signed, nothing sent.
      await assert.rejects(token.payout(d.request(undefined)), /process killed/);
      assert.equal(saved.length, 1);
      assert.equal(rpc.sent.length, sentBefore, "nothing was broadcast before the first crash");
      assert.equal(await node.nonce(gasWallet.address), gasNonce);

      // The re-run sends the saved top-up.
      assert.equal((await token.payout(again())).status, "pending");
      assert.equal(rpc.sent.length - sentBefore, 1);
      assert.ok(await node.isMined(saved[0]!.plan.transfers[0]!.txid));

      // Checkpoint 2 (top-up landed): crash before the token transfers go out.
      await assert.rejects(token.payout(again()), /process killed/);
      assert.equal(saved.length, 2);
      assert.equal(rpc.sent.length - sentBefore, 1, "nothing was broadcast before the second crash");
      assert.equal(await node.nonce(d.deposit.address), 0n);

      crash = false;
      const paid = await payUntilPaid(token, again);
      const paidAgain = await token.payout(again());

      assert.deepEqual(paidAgain, paid);
      assert.equal(rpc.sent.length - sentBefore, 4, "top-up, merchant and platform transfers and the sweep, each sent once");
      assert.equal(await node.nonce(gasWallet.address), gasNonce + 1n);
      assert.equal(await node.nonce(d.deposit.address), 3n);
      assert.equal(saved.length, 2, "the sweep needs no checkpoint of its own: it was signed and saved with the transfers");
      assert.equal(await tokens(d.destination), want.merchant);
      assert.deepEqual(paid.transfers.map((t) => t.kind), ["gas_top_up", "merchant_payout", "platform_fee", "gas_sweep"]);
    });

    it("keeps a transfer from running out of gas when the receiver empties its token balance after the estimate; the unaffordable sweep is skipped", async () => {
      await freshAdapters();
      const saved: PayoutCheckpoint[] = [];
      let crash = true;
      const d = await fundedDeposit(token, 100n * oneToken, {
        saveCheckpoint: async (next) => {
          saved.push(next);
          if (crash) throw new Error("process killed after the save");
          return true;
        },
      });
      // The merchant holds the token when the payout is planned: the cheap case.
      await node.payToken(tokenFacts.contract_address, d.destination, 1n);
      const want = await expectedTokenPayout(d, 100n * oneToken, FIVE_PERCENT);
      await assert.rejects(token.payout(d.request(undefined)), /process killed/);
      crash = false;

      // Then the merchant moves it out: its balance slot goes back to zero, and
      // the saved transfer now costs a fresh storage slot (about 17,000 gas more).
      await node.rpc("anvil_impersonateAccount", [d.destination]);
      await node.setBalance(d.destination, 10n ** 18n);
      const moveOut = await node.rpc<string>("eth_sendTransaction", [
        { from: d.destination, to: tokenFacts.contract_address, data: transferData(newAddress(), 1n), gasPrice: "0x" + GAS_PRICE.toString(16) },
      ]);
      while (!(await node.isMined(moveOut))) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await tokens(d.destination), 0n);

      const result = await payUntilPaid(token, () => ({ ...d.request(undefined), checkpoint: saved.at(-1) }));

      const merchantTx = result.transfers.find((t) => t.kind === "merchant_payout")!.txid;
      const receipt = await node.rpc<{ gasUsed: string; status: string }>("eth_getTransactionReceipt", [merchantTx]);
      assert.equal(receipt.status, "0x1");
      assert.ok(BigInt(receipt.gasUsed) > want.estimates[0]!, `used ${receipt.gasUsed}, more than the estimate ${want.estimates[0]}`);
      assert.ok(BigInt(receipt.gasUsed) <= want.estimates[0]! + TOKEN_GAS_MARGIN, "within the margin");
      assert.equal(await tokens(d.destination), want.merchant);
      assert.deepEqual(result.transfers.map((t) => t.kind), ["gas_top_up", "merchant_payout", "platform_fee"], "no sweep: it could not be paid for");
      assert.equal(await node.nonce(d.deposit.address), 2n, "the sweep never landed");
      assert.ok((await node.balance(d.deposit.address)) > 0n, "the unswept margin stays at the deposit");
    });

    it("rebuilds a gas top-up whose nonce another gas wallet transaction took, saving it first", async () => {
      await freshAdapters();
      const saved: PayoutCheckpoint[] = [];
      let crash = true;
      const d = await fundedDeposit(token, 100n * oneToken, {
        saveCheckpoint: async (next) => {
          saved.push(next);
          if (crash) throw new Error("process killed after the save");
          return true;
        },
      });
      const want = await expectedTokenPayout(d, 100n * oneToken, FIVE_PERCENT);
      await assert.rejects(token.payout(d.request(undefined)), /process killed/);
      crash = false;
      // Another payout's top-up takes the saved nonce first.
      const gasWalletOnNode = new Wallet(gasWallet.privateKey);
      const raw = await gasWalletOnNode.signTransaction({
        type: 0, chainId: spec.chainId, nonce: Number(await node.nonce(gasWallet.address)), gasPrice: GAS_PRICE, gasLimit: 21_000n, to: newAddress(), value: 1n,
      });
      await node.rpc("eth_sendRawTransaction", [raw]);
      const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });

      // Until the nonce was taken lostAfterBlocks ago, the saved top-up might be
      // the one that took it (a receipt not readable yet): nothing is rebuilt.
      assert.equal((await token.payout(again())).status, "pending");
      assert.equal(saved.length, 1, "no top-up rebuilt while the nonce was used only recently");
      await node.mine(Number(EVM_CHAINS[spec.name].lostAfterBlocks));

      const result = await payUntilPaid(token, again);

      const lostTopUp = saved[0]!.plan.transfers[0]!.txid;
      assert.equal(await node.isMined(lostTopUp), false);
      assert.notEqual(result.transfers[0]!.txid, lostTopUp, "the proof names the rebuilt top-up");
      assert.equal(saved[1]!.plan.transfers[0]!.txid, result.transfers[0]!.txid, "the rebuilt top-up was saved before it was sent");
      assert.equal(await tokens(d.destination), want.merchant);
    });

    it("says too small to forward, and sends nothing, when the gas would eat a token deposit", async () => {
      await freshAdapters();
      const tooSmall = oneToken / 100n;
      const d = await fundedDeposit(token, tooSmall);
      const want = await expectedTokenPayout(d, tooSmall, FIVE_PERCENT);
      assert.ok(want.reimbursed + want.fee >= tooSmall, "the case is too small");
      const sentBefore = rpc.sent.length;
      const gasBefore = await node.balance(gasWallet.address);

      const result = await token.payout(d.request());

      assert.equal(result.status, "too_small", show(result));
      assert.equal(d.saved.length, 0);
      assert.equal(rpc.sent.length, sentBefore);
      assert.equal(await node.balance(gasWallet.address), gasBefore);
      assert.equal(await tokens(d.deposit.address), tooSmall);
    });

    it("pays a payer-pays token invoice paid exactly: the merchant gets the invoice amount plus the estimate's gap (story 63)", async () => {
      await freshAdapters();
      const invoiceAmount = 250n * oneToken;
      const estimate = await token.estimateNetworkCost();
      assert.equal(estimate, reimbursement(GAS_PRICE * (2n * PAYER_PAYS_TOKEN_TRANSFER_GAS + SWEEP_GAS)));
      const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost: estimate!, feeRate: FIVE_PERCENT });
      const d = await fundedDeposit(token, asked);
      const want = await expectedTokenPayout(d, asked, FIVE_PERCENT);

      await payUntilPaid(token, d.request);

      assert.equal(await tokens(d.destination), want.merchant);
      assert.ok(want.merchant >= invoiceAmount, "the estimate covers the real charge, so the merchant gets at least the invoice amount");
      assert.ok(want.merchant - invoiceAmount <= estimate! - want.reimbursed + 1n, "the gap is the estimate's own");
      assert.equal(await tokens(platform), asked - want.merchant);
    });

    it("waits with a review note, sending nothing, when the gas wallet key is missing", async () => {
      await freshAdapters({ gasWalletKey: false });
      const d = await fundedDeposit(token, 10n * oneToken);
      const sentBefore = rpc.sent.length;

      const result = await token.payout(d.request());

      assert.equal(result.status, "pending", show(result));
      assert.match((result as { review?: string }).review ?? "", /gas wallet key is not configured/);
      assert.match((result as { review?: string }).review ?? "", new RegExp(d.deposit.address));
      assert.equal(d.saved.length, 0);
      assert.equal(rpc.sent.length, sentBefore);
      assert.ok(await token.getPayments(d.deposit.address), "payments are still detected");
    });

    it("waits, sending nothing, when no price converts the gas cost", async () => {
      await freshAdapters();
      prices[spec.native] = undefined;
      const d = await fundedDeposit(token, 10n * oneToken);
      const sentBefore = rpc.sent.length;

      const result = await token.payout(d.request());

      assert.equal(result.status, "pending", show(result));
      assert.equal(d.saved.length, 0);
      assert.equal(rpc.sent.length, sentBefore);
      assert.equal(await token.estimateNetworkCost(), undefined);
    });
  });
}
