import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseFeeRate, splitPayout } from "../../src/money/payout-split.js";

// The one rule every chain's payout uses to split a deposit between the
// platform and the merchant. Amounts are in the coin's smallest unit.

const FIVE_PERCENT = 5_000_000n; // 0.05 with 8 decimals

describe("splitPayout", () => {
  it("takes the fee rate of what is left after the network cost", () => {
    assert.deepEqual(
      splitPayout({ received: 100_000n, networkCost: 1_000n, feeRate: FIVE_PERCENT }),
      { platformFee: 4_950n, merchantAmount: 94_050n },
    );
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

  it("returns nothing when the network cost uses up the deposit", () => {
    assert.equal(splitPayout({ received: 700n, networkCost: 700n, feeRate: FIVE_PERCENT }), undefined);
    assert.equal(splitPayout({ received: 500n, networkCost: 700n, feeRate: FIVE_PERCENT }), undefined);
  });

  it("can leave the merchant 0 on a tiny deposit; the chain decides if that is payable", () => {
    assert.deepEqual(
      splitPayout({ received: 701n, networkCost: 700n, feeRate: FIVE_PERCENT }),
      { platformFee: 1n, merchantAmount: 0n },
    );
  });

  it("never creates or loses a unit: fee + merchant + network = received", () => {
    for (let i = 0; i < 2_000; i++) {
      const received = BigInt(Math.floor(Math.random() * 1e15));
      const networkCost = BigInt(Math.floor(Math.random() * 1e6));
      const feeRate = BigInt(Math.floor(Math.random() * 99_999_999));
      const split = splitPayout({ received, networkCost, feeRate });
      if (split === undefined) {
        assert.ok(received <= networkCost);
        continue;
      }
      assert.equal(split.platformFee + split.merchantAmount + networkCost, received);
      assert.ok(split.platformFee >= 0n && split.merchantAmount >= 0n);
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
