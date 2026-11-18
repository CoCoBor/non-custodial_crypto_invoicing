import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import bitcore from "bitcore-lib";
import litecore from "bitcore-lib-ltc";

import type { ChainAdapter, PayoutCheckpoint, PayoutRequest, PayoutResult } from "../../../src/chains/adapter.js";
import { createBlockbookApi } from "../../../src/chains/blockbook.js";
import { createBtcAdapter } from "../../../src/chains/btc.js";
import { createLtcAdapter } from "../../../src/chains/ltc.js";
import { parseFeeRate, payerPaysAskedAmount } from "../../../src/money/payout-split.js";
import { startBlockbookShim, type BlockbookShim } from "./blockbook-shim.js";
import { dockerUnavailable, startRegtestNode, type RegtestNode, type UtxoChain } from "./node.js";

// Spec seam 3 for the UTXO chains: the real BTC and LTC adapters pay out from
// a deposit on a throwaway regtest node (Docker), reached through a
// Blockbook-shaped shim. Never mainnet. Every amount is read back from the
// node's own UTXO set by output script.
//
// The shim's fee rate is 0.0001 coin/kB = 10,000 base units per 1,000 bytes.
// Sizes: one P2PKH input (148) + 10 bytes of framing + each output's script
// length + 9. P2PKH script 25, P2WPKH 22, P2WSH 34.

const skipReason = await dockerUnavailable();
if (skipReason !== undefined) console.warn(skipReason);

const FIVE_PERCENT = parseFeeRate("0.05")!;
const RECEIVED = 1_000_000n;

type Lib = typeof bitcore;

const CHAINS: { chain: UtxoChain; lib: Lib; tooSmall: bigint; makeAdapter: (platform: string, shim: BlockbookShim) => ChainAdapter }[] = [
  {
    chain: "btc",
    lib: bitcore,
    // Dust for a P2PKH output is 546 sat; 2,000 − 1,920 network cost leaves 80.
    tooSmall: 2_000n,
    makeAdapter: (platformAddress, shim) =>
      createBtcAdapter({ platformAddress, api: blockbookAt(shim.url, "BTC") }),
  },
  {
    chain: "ltc",
    lib: litecore as unknown as Lib,
    // Litecoin's P2PKH dust is 5,460 litoshi; 7,000 − 1,920 leaves 5,080.
    tooSmall: 7_000n,
    makeAdapter: (platformAddress, shim) =>
      createLtcAdapter({ platformAddress, api: blockbookAt(shim.url, "LTC") }),
  },
];

function blockbookAt(baseUrl: string, label: string) {
  return createBlockbookApi({ baseUrl, label });
}

function show(result: PayoutResult): string {
  return JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

function networkCost(outputScriptLengths: number[]): bigint {
  const size = 10 + 148 + outputScriptLengths.reduce((sum, length) => sum + length + 9, 0);
  return BigInt(Math.ceil((size * 10_000) / 1000));
}

for (const { chain, lib, tooSmall, makeAdapter } of CHAINS) {
  describe(`${chain.toUpperCase()} payouts on a regtest node`, { skip: skipReason }, () => {
    let node: RegtestNode;
    let shim: BlockbookShim;
    let platform: string;
    let adapter: ChainAdapter;

    const livenet = lib.Networks.livenet;
    const p2pkh = () => new lib.PrivateKey(undefined, livenet).toAddress().toString();
    // bitcore has these; its types leave them out.
    const Address = lib.Address as unknown as {
      fromPublicKey(key: unknown, network: unknown, type: string): { toString(): string };
      payingTo(script: unknown, network: unknown, type: string): { toString(): string };
    };
    const Script = lib.Script as unknown as { buildMultisigOut(keys: unknown[], threshold: number): unknown };
    const p2wpkh = () =>
      Address.fromPublicKey(new lib.PrivateKey(undefined, livenet).toPublicKey(), livenet, "witnesspubkeyhash").toString();
    const p2wsh = () =>
      Address.payingTo(
        Script.buildMultisigOut([new lib.PrivateKey(undefined, livenet).toPublicKey()], 1),
        livenet,
        "witnessscripthash",
      ).toString();

    before(async () => {
      node = await startRegtestNode(chain);
      shim = await startBlockbookShim(node);
    });

    after(async () => {
      await shim?.stop();
      await node?.stop();
    });

    /** A fresh adapter with its own platform wallet, so balances start at 0. */
    function freshPlatform(address = p2wpkh()) {
      platform = address;
      adapter = makeAdapter(platform, shim);
    }

    /** A deposit holding `amounts`, each its own confirmed payment, and a request builder. */
    async function fundedDeposit(amounts: bigint[], fields: Partial<PayoutRequest> = {}) {
      const deposit = await adapter.newDeposit();
      for (const amount of amounts) await node.pay(deposit.address, amount);
      await node.mine(1);
      const saved: PayoutCheckpoint[] = [];
      const base = (): PayoutRequest => ({
        depositAddress: deposit.address,
        depositKey: deposit.key,
        destination: p2pkh(),
        destinationKind: "merchant_payout",
        receiveAsset: chain,
        feeRate: FIVE_PERCENT,
        minimumAmount: amounts.reduce((a, b) => a + b, 0n),
        checkpoint: undefined,
        saveCheckpoint: async (next) => {
          saved.push(next);
          return true;
        },
        ...fields,
      });
      const fixed = base();
      const request = (checkpoint = saved.at(-1)): PayoutRequest => ({ ...fixed, checkpoint });
      return { deposit, saved, request, destination: fixed.destination };
    }

    /** Calls payout until the chain proves it, mining a block after the broadcast. */
    async function payUntilPaid(request: () => PayoutRequest): Promise<PayoutResult> {
      const first = await adapter.payout(request());
      assert.equal(first.status, "pending", show(first));
      await node.mine(1);
      const second = await adapter.payout(request());
      assert.equal(second.status, "paid", show(second));
      return second;
    }

    it("lists the deposit's payment from the node, with its confirmations and time", async () => {
      freshPlatform();
      const d = await fundedDeposit([RECEIVED]);

      const payments = await adapter.getPayments(d.deposit.address);

      assert.equal(payments?.length, 1);
      assert.equal(payments![0]!.amount, RECEIVED);
      assert.equal(payments![0]!.confirmations, 1);
      assert.ok(payments![0]!.seenAt! > Date.now() - 3_600_000);
    });

    it("pays the merchant at 5%: the exact shares reach merchant and platform, and the fee is what was planned", async () => {
      freshPlatform();
      const d = await fundedDeposit([RECEIVED]);
      const cost = networkCost([25, 22]);
      const platformFee = 50_000n;
      const merchantAmount = RECEIVED - platformFee - cost;

      const first = await adapter.payout(d.request());

      assert.equal(first.status, "pending");
      assert.equal(d.saved.length, 1);
      const plan = d.saved[0]!.plan;
      assert.equal(plan.networkCost, cost);
      assert.equal(plan.platformFee, platformFee);
      const txid = plan.transfers[0]!.txid;
      assert.deepEqual(await node.mempool(), [txid]);
      assert.equal(await node.mempoolFee(txid), cost, "the node's fee equals the planned network cost");

      await node.mine(1);
      const result = await adapter.payout(d.request());

      assert.equal(result.status, "paid");
      if (result.status !== "paid") return;
      assert.deepEqual(
        result.transfers.map((t) => [t.kind, t.to, t.amount]),
        [
          ["merchant_payout", d.destination, merchantAmount],
          ["platform_fee", platform, platformFee],
        ],
      );
      assert.equal(await node.balance(d.destination), merchantAmount);
      assert.equal(await node.balance(platform), platformFee);
      assert.equal(await node.balance(d.deposit.address), 0n);
    });

    it("pays the merchant at 0%: no platform output, the merchant gets all but the network cost", async () => {
      freshPlatform();
      const d = await fundedDeposit([RECEIVED], { feeRate: 0n });
      const cost = networkCost([25]);

      const result = await payUntilPaid(d.request);

      if (result.status !== "paid") return;
      assert.deepEqual(result.transfers.map((t) => [t.kind, t.amount]), [["merchant_payout", RECEIVED - cost]]);
      assert.equal(await node.balance(d.destination), RECEIVED - cost);
      assert.equal(await node.balance(platform), 0n);
      assert.equal(await node.balance(d.deposit.address), 0n);
    });

    it("charges the fee only on the part of the money that has not paid it yet (a refunded swap's money)", async () => {
      freshPlatform();
      const exempt = (RECEIVED * 3n) / 5n;
      const d = await fundedDeposit([RECEIVED], { destinationKind: "refund_route", feeExempt: exempt });
      const cost = networkCost([25, 22]);
      const platformFee = ((RECEIVED - exempt) * FIVE_PERCENT + 10n ** 8n - 1n) / 10n ** 8n;

      const result = await payUntilPaid(d.request);

      if (result.status !== "paid") return;
      assert.deepEqual(result.transfers.map((t) => [t.kind, t.amount]), [
        ["refund_route", RECEIVED - platformFee - cost],
        ["platform_fee", platformFee],
      ]);
      assert.equal(await node.balance(platform), platformFee);
      assert.equal(await node.balance(d.deposit.address), 0n);
    });

    it("routes late money to a refund address after the merchant payout completed, without paying the merchant again", async () => {
      freshPlatform();
      const d = await fundedDeposit([RECEIVED]);
      await payUntilPaid(d.request);
      const merchantBefore = await node.balance(d.destination);
      const platformBefore = await node.balance(platform);

      const late = 300_000n;
      await node.pay(d.deposit.address, late);
      await node.mine(1);
      const refundAddress = p2pkh();
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

      const result = await payUntilPaid(route);

      const cost = networkCost([25, 22]);
      if (result.status !== "paid") return;
      assert.deepEqual(
        result.transfers.map((t) => [t.kind, t.to, t.amount]),
        [
          ["refund_route", refundAddress, late - 15_000n - cost],
          ["platform_fee", platform, 15_000n],
        ],
      );
      assert.equal(await node.balance(refundAddress), late - 15_000n - cost);
      assert.equal(await node.balance(platform), platformBefore + 15_000n);
      assert.equal(await node.balance(d.destination), merchantBefore, "the merchant was not paid again");
      assert.equal(await node.balance(d.deposit.address), 0n);
    });

    it("after a crash right after the checkpoint was saved, sends that one transaction once and never again", async () => {
      freshPlatform();
      const saved: PayoutCheckpoint[] = [];
      const d = await fundedDeposit([RECEIVED], {
        saveCheckpoint: async (next) => {
          saved.push(next);
          throw new Error("process killed after the save");
        },
      });
      const sentBefore = shim.state.sent.length;
      const again = (): PayoutRequest => ({ ...d.request(undefined), checkpoint: saved.at(-1) });

      await assert.rejects(adapter.payout(d.request(undefined)), /process killed/);
      assert.equal(saved.length, 1);
      assert.deepEqual(await node.mempool(), [], "nothing was broadcast before the crash");

      assert.equal((await adapter.payout(again())).status, "pending");
      assert.equal((await adapter.payout(again())).status, "pending");
      assert.equal(shim.state.sent.length - sentBefore, 1, "the saved transaction is sent once while it waits in the mempool");
      assert.deepEqual(await node.mempool(), [saved[0]!.plan.transfers[0]!.txid]);

      await node.mine(1);
      const paid = await adapter.payout(again());
      const paidAgain = await adapter.payout(again());

      assert.equal(paid.status, "paid");
      assert.deepEqual(paidAgain, paid);
      assert.equal(shim.state.sent.length - sentBefore, 1, "nothing was sent after it was proven");
      assert.equal(saved.length, 1, "no second transaction was built");
      assert.equal(await node.balance(d.destination), RECEIVED - 50_000n - networkCost([25, 22]));
    });

    it("says too small to forward, and sends nothing, when fees would leave the merchant less than dust", async () => {
      freshPlatform();
      const d = await fundedDeposit([tooSmall]);
      const sentBefore = shim.state.sent.length;

      const result = await adapter.payout(d.request());

      assert.equal(result.status, "too_small");
      assert.equal(d.saved.length, 0);
      assert.equal(shim.state.sent.length, sentBefore);
      assert.deepEqual(await node.mempool(), []);
      assert.equal(await node.balance(d.deposit.address), tooSmall);
    });

    it("pays a payer-pays invoice paid exactly: the merchant receives exactly the invoice amount", async () => {
      // The estimate assumes two outputs of the widest standard script, so
      // with P2WSH merchant and platform addresses the real cost equals it.
      freshPlatform(p2wsh());
      const invoiceAmount = 500_000n;
      const estimate = await adapter.estimateNetworkCost();
      assert.equal(estimate, networkCost([34, 34]));
      const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost: estimate!, feeRate: FIVE_PERCENT });
      const d = await fundedDeposit([asked], { destination: p2wsh(), minimumAmount: asked });

      const result = await payUntilPaid(d.request);

      if (result.status !== "paid") return;
      assert.equal(await node.balance(d.destination), invoiceAmount);
      assert.equal(await node.balance(platform), asked - invoiceAmount - estimate!);
      assert.equal(await node.balance(d.deposit.address), 0n);
    });
  });
}
