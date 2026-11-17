import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acceptedPaymentAmount } from "../../src/invoice/payment-rules.js";

// The watcher confirms at this amount and the BTC/TON payouts release at it:
// if they disagreed, a confirmed invoice could never be paid out.
describe("the least that pays an invoice", () => {
  it("is the full amount without a tolerance", () => {
    assert.equal(acceptedPaymentAmount({ amount: "100000" }), 100_000n);
    assert.equal(acceptedPaymentAmount({ amount: "100000", underpaid: 0 }), 100_000n);
  });

  it("is the amount less the tolerance, rounded up", () => {
    assert.equal(acceptedPaymentAmount({ amount: "100000", underpaid: 5 }), 95_000n);
    assert.equal(acceptedPaymentAmount({ amount: "100001", underpaid: 2.5 }), 97_501n);
  });

  it("falls back to the full amount for a tolerance outside 0-5%", () => {
    assert.equal(acceptedPaymentAmount({ amount: "100000", underpaid: 50 }), 100_000n);
    assert.equal(acceptedPaymentAmount({ amount: "100000", underpaid: -1 }), 100_000n);
  });
});
