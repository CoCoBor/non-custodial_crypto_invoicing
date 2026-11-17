import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FEE_RATE_SCALE, parseFeeRate, splitPayout } from "../../src/money/payout-split.js";

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

  it("refuses impossible input as a programming error", () => {
    assert.throws(() => splitPayout({ received: -1n, networkCost: 0n, feeRate: 0n }), RangeError);
    assert.throws(() => splitPayout({ received: 1n, networkCost: -1n, feeRate: 0n }), RangeError);
    assert.throws(() => splitPayout({ received: 1n, networkCost: 0n, feeRate: 100_000_000n }), RangeError);
    assert.throws(() => splitPayout({ received: 1n, networkCost: 0n, feeRate: -1n }), RangeError);
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
