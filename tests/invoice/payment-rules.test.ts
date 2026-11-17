import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acceptedPaymentAmount, askedAmount } from "../../src/invoice/payment-rules.js";

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

  it("starts from the asked amount, not the invoice amount, in payer-pays mode", () => {
    const invoice = { amount: "100000", asked_amount: "106316" };
    assert.equal(acceptedPaymentAmount(invoice), 106_316n);
    // 5% of 106,316 is 5,315.8: the payer must send at least 101,001
    assert.equal(acceptedPaymentAmount({ ...invoice, underpaid: 5 }), 101_001n);
  });
});

describe("the amount the payer is asked for", () => {
  it("is the asked amount when the invoice has one", () => {
    assert.equal(askedAmount({ amount: "100000", asked_amount: "106316" }), 106_316n);
  });

  it("is the invoice amount for invoices made before the asked amount was stored", () => {
    assert.equal(askedAmount({ amount: "100000" }), 100_000n);
    assert.equal(askedAmount({ amount: "100000", asked_amount: "" }), 100_000n);
    assert.equal(askedAmount({ amount: "100000", asked_amount: null }), 100_000n);
  });
});
