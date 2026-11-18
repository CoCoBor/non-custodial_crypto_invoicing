import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FEE_RATE_SCALE,
  parseFeeRate,
  payerPaysAskedAmount,
  splitPayout,
} from "../../src/money/payout-split.js";

// The one rule every chain's payout uses to split a deposit between the
// platform and the merchant. Amounts are in the coin's smallest unit.

const FIVE_PERCENT = 5_000_000n; // 0.05 with 8 decimals

describe("splitPayout", () => {
  it("takes the fee rate of everything received; the network cost comes from the merchant's share", () => {
    // fee = 5% × 100,000 = 5,000; merchant = 100,000 − 5,000 − 1,000 = 94,000
    assert.deepEqual(
      splitPayout({ received: 100_000n, networkCost: 1_000n, feeRate: FIVE_PERCENT }),
      { platformFee: 5_000n, merchantAmount: 94_000n },
    );
  });

  it("charges the same fee whatever the network cost", () => {
    for (const networkCost of [0n, 1n, 1_000n, 90_000n]) {
      assert.equal(
        splitPayout({ received: 100_000n, networkCost, feeRate: FIVE_PERCENT })?.platformFee,
        5_000n,
      );
    }
  });

  it("rounds the platform fee up, never down", () => {
    // 1001 × 0.5% = 5.005
    assert.deepEqual(
      splitPayout({ received: 1_001n, networkCost: 0n, feeRate: parseFeeRate("0.005")! }),
      { platformFee: 6n, merchantAmount: 995n },
    );
  });

  it("charges nothing at a 0% rate", () => {
    assert.deepEqual(
      splitPayout({ received: 50_000n, networkCost: 700n, feeRate: 0n }),
      { platformFee: 0n, merchantAmount: 49_300n },
    );
  });

  it("is too small to forward when the network cost alone uses up the deposit", () => {
    assert.equal(splitPayout({ received: 700n, networkCost: 700n, feeRate: FIVE_PERCENT }), undefined);
    assert.equal(splitPayout({ received: 500n, networkCost: 700n, feeRate: FIVE_PERCENT }), undefined);
    assert.equal(splitPayout({ received: 700n, networkCost: 700n, feeRate: 0n }), undefined);
  });

  it("is too small to forward when the fee plus the network cost leave the merchant nothing", () => {
    // 701: fee = ceil(35.05) = 36; merchant = 701 − 36 − 700 = −35
    assert.equal(splitPayout({ received: 701n, networkCost: 700n, feeRate: FIVE_PERCENT }), undefined);
    // 737: fee = ceil(36.85) = 37; merchant = 737 − 37 − 700 = 0
    assert.equal(splitPayout({ received: 737n, networkCost: 700n, feeRate: FIVE_PERCENT }), undefined);
    // 738: fee = ceil(36.9) = 37; merchant = 738 − 37 − 700 = 1, the least it forwards
    assert.deepEqual(
      splitPayout({ received: 738n, networkCost: 700n, feeRate: FIVE_PERCENT }),
      { platformFee: 37n, merchantAmount: 1n },
    );
  });

  it("never creates or loses a unit: fee + merchant + network = received", () => {
    for (let i = 0; i < 2_000; i++) {
      const received = BigInt(Math.floor(Math.random() * 1e15));
      const networkCost = BigInt(Math.floor(Math.random() * 1e6));
      const feeRate = BigInt(Math.floor(Math.random() * 99_999_999));
      const fee = (received * feeRate + FEE_RATE_SCALE - 1n) / FEE_RATE_SCALE;
      const split = splitPayout({ received, networkCost, feeRate });
      if (split === undefined) {
        assert.ok(received - fee - networkCost <= 0n);
        continue;
      }
      assert.equal(split.platformFee, fee);
      assert.equal(split.platformFee + split.merchantAmount + networkCost, received);
      assert.ok(split.merchantAmount >= 1n);
    }
  });

  it("takes no fee on money that already paid it (a refunded swap's money), and the rate on the rest", () => {
    // fee = ceil(5% × (100,000 − 60,000)) = 2,000; merchant = 100,000 − 2,000 − 1,000 = 97,000
    assert.deepEqual(
      splitPayout({ received: 100_000n, networkCost: 1_000n, feeRate: FIVE_PERCENT, feeExempt: 60_000n }),
      { platformFee: 2_000n, merchantAmount: 97_000n },
    );
    // All of it already paid: no fee, the network cost still comes out.
    assert.deepEqual(
      splitPayout({ received: 92_000n, networkCost: 1_000n, feeRate: FIVE_PERCENT, feeExempt: 94_000n }),
      { platformFee: 0n, merchantAmount: 91_000n },
    );
    assert.equal(splitPayout({ received: 1_000n, networkCost: 1_000n, feeRate: FIVE_PERCENT, feeExempt: 1_000n }), undefined);
  });

  it("refuses impossible input as a programming error", () => {
    assert.throws(() => splitPayout({ received: 1n, networkCost: 0n, feeRate: 0n, feeExempt: -1n }), RangeError);
    assert.throws(() => splitPayout({ received: -1n, networkCost: 0n, feeRate: 0n }), RangeError);
    assert.throws(() => splitPayout({ received: 1n, networkCost: -1n, feeRate: 0n }), RangeError);
    assert.throws(() => splitPayout({ received: 1n, networkCost: 0n, feeRate: 100_000_000n }), RangeError);
    assert.throws(() => splitPayout({ received: 1n, networkCost: 0n, feeRate: -1n }), RangeError);
  });
});

describe("payerPaysAskedAmount", () => {
  // asked = ceil((invoice + estimate) / (1 − rate)): the least that, split by
  // F1 with the estimated network cost, leaves the merchant the invoice amount.
  const cases: {
    name: string;
    invoiceAmount: bigint;
    estimatedNetworkCost: bigint;
    feeRate: bigint;
    asked: bigint;
  }[] = [
    // 100,000 + 1,000
    { name: "0%: the invoice plus the estimate", invoiceAmount: 100_000n, estimatedNetworkCost: 1_000n, feeRate: 0n, asked: 101_000n },
    // 101,000 / 0.95 = 106,315.79 → 106,316; fee = ceil(5,315.8) = 5,316; 106,316 − 5,316 − 1,000 = 100,000
    { name: "5%, rounded up", invoiceAmount: 100_000n, estimatedNetworkCost: 1_000n, feeRate: FIVE_PERCENT, asked: 106_316n },
    // 95,000 / 0.95 = 100,000 exactly; fee = 5,000; 100,000 − 5,000 − 1,000 = 94,000
    { name: "5%, dividing exactly", invoiceAmount: 94_000n, estimatedNetworkCost: 1_000n, feeRate: FIVE_PERCENT, asked: 100_000n },
    // 20 / 0.95 = 21.05 → 22, not 21: at 21 the fee is ceil(1.05) = 2, leaving 19
    { name: "5%, where the rounded-up fee costs one more unit", invoiceAmount: 20n, estimatedNetworkCost: 0n, feeRate: FIVE_PERCENT, asked: 22n },
    // 1 / 0.995 = 1.005 → 2; fee = ceil(0.01) = 1; 2 − 1 = 1
    { name: "0.5% on the smallest amount", invoiceAmount: 1n, estimatedNetworkCost: 0n, feeRate: parseFeeRate("0.005")!, asked: 2n },
    // 5.005 TON / 0.95 = 5.268421052… TON → 5,268,421,053 nanoton
    { name: "5% on a TON invoice with the TON fee budget", invoiceAmount: 5_000_000_000n, estimatedNetworkCost: 5_000_000n, feeRate: FIVE_PERCENT, asked: 5_268_421_053n },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.asked}`, () => {
      const asked = payerPaysAskedAmount(c);
      assert.equal(asked, c.asked);

      const paidInFull = splitPayout({ received: asked, networkCost: c.estimatedNetworkCost, feeRate: c.feeRate });
      assert.equal(paidInFull?.merchantAmount, c.invoiceAmount, "paying the asked amount leaves the merchant the invoice amount");
      const oneShort = splitPayout({ received: asked - 1n, networkCost: c.estimatedNetworkCost, feeRate: c.feeRate });
      assert.ok(oneShort === undefined || oneShort.merchantAmount < c.invoiceAmount, "the asked amount is not the least");
    });
  }

  it("always leaves the merchant exactly the invoice amount, and one unit less would not", () => {
    for (let i = 0; i < 2_000; i++) {
      const invoiceAmount = 1n + BigInt(Math.floor(Math.random() * 1e15));
      const estimatedNetworkCost = BigInt(Math.floor(Math.random() * 1e7));
      const feeRate = i % 10 === 0 ? 0n : BigInt(Math.floor(Math.random() * 99_999_999));
      const asked = payerPaysAskedAmount({ invoiceAmount, estimatedNetworkCost, feeRate });

      assert.equal(
        splitPayout({ received: asked, networkCost: estimatedNetworkCost, feeRate })?.merchantAmount,
        invoiceAmount,
      );
      const oneShort = splitPayout({ received: asked - 1n, networkCost: estimatedNetworkCost, feeRate });
      assert.ok(oneShort === undefined || oneShort.merchantAmount < invoiceAmount);
    }
  });

  it("refuses impossible input as a programming error", () => {
    assert.throws(() => payerPaysAskedAmount({ invoiceAmount: 0n, estimatedNetworkCost: 0n, feeRate: 0n }), RangeError);
    assert.throws(() => payerPaysAskedAmount({ invoiceAmount: 1n, estimatedNetworkCost: -1n, feeRate: 0n }), RangeError);
    assert.throws(() => payerPaysAskedAmount({ invoiceAmount: 1n, estimatedNetworkCost: 0n, feeRate: -1n }), RangeError);
    assert.throws(() => payerPaysAskedAmount({ invoiceAmount: 1n, estimatedNetworkCost: 0n, feeRate: FEE_RATE_SCALE }), RangeError);
  });
});

describe("parseFeeRate", () => {
  it("reads a merchant fee rate as an exact 8-decimal integer", () => {
    assert.equal(parseFeeRate("0.05"), FIVE_PERCENT);
    assert.equal(parseFeeRate("0.005"), 500_000n);
    assert.equal(parseFeeRate("0"), 0n);
    assert.equal(parseFeeRate("0.00000001"), 1n);
    assert.equal(parseFeeRate("0.99999999"), 99_999_999n);
  });

  it("refuses anything that is not a rate from 0% up to (not including) 100%", () => {
    for (const bad of ["1", "1.0", "1.5", "-0.05", "0.123456789", "5%", "abc", ""]) {
      assert.equal(parseFeeRate(bad), undefined, `accepted ${JSON.stringify(bad)}`);
    }
  });
});
