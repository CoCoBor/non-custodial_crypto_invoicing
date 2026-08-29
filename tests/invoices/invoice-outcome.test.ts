import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideInvoiceOutcome,
  type ObservedPayment,
} from "../../src/invoices/invoice-outcome.js";
import type { InvoiceStatus } from "../../src/invoices/invoice.model.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const LATER = new Date("2026-08-29T12:30:00.000Z");
const EARLIER = new Date("2026-08-29T11:30:00.000Z");

const AMOUNT = 500_000;

function invoice(overrides: Partial<{
  amountSatoshi: number;
  underpaidTolerancePercent: number;
  expiresAt: Date;
  status: InvoiceStatus;
}> = {}) {
  return {
    amountSatoshi: AMOUNT,
    underpaidTolerancePercent: 0,
    expiresAt: LATER,
    status: "waiting" as InvoiceStatus,
    ...overrides,
  };
}

function observed(
  confirmedSatoshi: number,
  pendingSatoshi = 0,
): ObservedPayment {
  return { confirmedSatoshi, pendingSatoshi };
}

describe("nothing has arrived yet", () => {
  it("keeps waiting while the invoice is still live", () => {
    assert.equal(decideInvoiceOutcome(invoice(), observed(0), NOW).status, "waiting");
  });

  it("expires once the deadline has passed", () => {
    const result = decideInvoiceOutcome(
      invoice({ expiresAt: EARLIER }),
      observed(0),
      NOW,
    );

    assert.equal(result.status, "expired");
  });

  it("expires exactly at the deadline, not a moment after", () => {
    assert.equal(
      decideInvoiceOutcome(invoice({ expiresAt: NOW }), observed(0), NOW).status,
      "expired",
    );
  });
});

describe("money is in the mempool but not yet in a block", () => {
  it("reports confirming rather than confirmed", () => {
    const result = decideInvoiceOutcome(invoice(), observed(0, AMOUNT), NOW);

    assert.equal(
      result.status,
      "confirming",
      "an unconfirmed transaction can still be replaced or dropped",
    );
  });

  it("does not expire an invoice whose payment is already in flight", () => {
    const result = decideInvoiceOutcome(
      invoice({ expiresAt: EARLIER }),
      observed(0, AMOUNT),
      NOW,
    );

    assert.equal(
      result.status,
      "confirming",
      "the payer paid in time; waiting for blocks must not cost them the invoice",
    );
  });

  it("counts pending money towards the total shown to the merchant", () => {
    const result = decideInvoiceOutcome(invoice(), observed(100_000, 400_000), NOW);

    assert.equal(result.status, "confirming");
    assert.equal("paidSatoshi" in result && result.paidSatoshi, 500_000);
  });
});

describe("the payer sent the exact amount", () => {
  it("confirms the invoice", () => {
    const result = decideInvoiceOutcome(invoice(), observed(AMOUNT), NOW);

    assert.equal(result.status, "confirmed");
  });

  it("records nothing as overpaid", () => {
    const result = decideInvoiceOutcome(invoice(), observed(AMOUNT), NOW);

    assert.equal("overpaidSatoshi" in result && result.overpaidSatoshi, 0);
  });

  it("confirms even if the deadline has passed, because the money is there", () => {
    const result = decideInvoiceOutcome(
      invoice({ expiresAt: EARLIER }),
      observed(AMOUNT),
      NOW,
    );

    assert.equal(result.status, "confirmed");
  });
});

describe("the payer sent too much", () => {
  it("confirms the invoice", () => {
    assert.equal(
      decideInvoiceOutcome(invoice(), observed(AMOUNT + 12_345), NOW).status,
      "confirmed",
    );
  });

  it("records the surplus, which belongs to the merchant", () => {
    const result = decideInvoiceOutcome(invoice(), observed(AMOUNT + 12_345), NOW);

    assert.equal("overpaidSatoshi" in result && result.overpaidSatoshi, 12_345);
  });
});

describe("the payer sent too little and there is no tolerance", () => {
  it("marks the invoice underpaid rather than failing it", () => {
    const result = decideInvoiceOutcome(invoice(), observed(400_000), NOW);

    assert.equal(result.status, "underpaid");
  });

  it("reports how much is still owed", () => {
    const result = decideInvoiceOutcome(invoice(), observed(400_000), NOW);

    assert.equal("remainingSatoshi" in result && result.remainingSatoshi, 100_000);
  });

  it("is one satoshi short and still underpaid", () => {
    assert.equal(
      decideInvoiceOutcome(invoice(), observed(AMOUNT - 1), NOW).status,
      "underpaid",
    );
  });

  it("expires once the deadline passes, and the funds stay the merchant's", () => {
    const result = decideInvoiceOutcome(
      invoice({ expiresAt: EARLIER }),
      observed(400_000),
      NOW,
    );

    assert.equal(
      result.status,
      "expired",
      "expiry closes the invoice; it does not un-receive the bitcoin",
    );
  });
});

describe("the payer sent too little but within the merchant's tolerance", () => {
  const tolerant = () => invoice({ underpaidTolerancePercent: 5 });

  it("confirms a payment just above the threshold", () => {
    // 5% of 500000 is 25000, so 475000 is the lowest acceptable amount
    assert.equal(
      decideInvoiceOutcome(tolerant(), observed(475_000), NOW).status,
      "confirmed",
    );
  });

  it("confirms a payment exactly on the threshold", () => {
    assert.equal(
      decideInvoiceOutcome(tolerant(), observed(475_000), NOW).status,
      "confirmed",
    );
  });

  it("still refuses a payment one satoshi below the threshold", () => {
    assert.equal(
      decideInvoiceOutcome(tolerant(), observed(474_999), NOW).status,
      "underpaid",
    );
  });

  it("does not treat the shortfall as an overpayment", () => {
    const result = decideInvoiceOutcome(tolerant(), observed(475_000), NOW);

    assert.equal("overpaidSatoshi" in result && result.overpaidSatoshi, 0);
  });

  it("rounds the threshold in the merchant's favour", () => {
    // 5% of 333333 is 16666.65; discounting only 16666 keeps the bar higher
    const result = decideInvoiceOutcome(
      invoice({ amountSatoshi: 333_333, underpaidTolerancePercent: 5 }),
      observed(316_667),
      NOW,
    );

    assert.equal(result.status, "confirmed");
    assert.equal(
      decideInvoiceOutcome(
        invoice({ amountSatoshi: 333_333, underpaidTolerancePercent: 5 }),
        observed(316_666),
        NOW,
      ).status,
      "underpaid",
    );
  });

  it("accepts anything at all when the tolerance is one hundred percent", () => {
    assert.equal(
      decideInvoiceOutcome(
        invoice({ underpaidTolerancePercent: 100 }),
        observed(1),
        NOW,
      ).status,
      "confirmed",
    );
  });
});

describe("invoices that have already settled", () => {
  it("leaves a confirmed invoice confirmed even after it would have expired", () => {
    const result = decideInvoiceOutcome(
      invoice({ status: "confirmed", expiresAt: EARLIER }),
      observed(AMOUNT),
      NOW,
    );

    assert.equal(result.status, "confirmed");
  });

  it("leaves an expired invoice expired when nothing new arrives", () => {
    const result = decideInvoiceOutcome(
      invoice({ status: "expired", expiresAt: EARLIER }),
      observed(0),
      NOW,
    );

    assert.equal(result.status, "expired");
  });

  it("still settles an expired invoice if the money turns up late", () => {
    const result = decideInvoiceOutcome(
      invoice({ status: "expired", expiresAt: EARLIER }),
      observed(AMOUNT),
      NOW,
    );

    assert.equal(
      result.status,
      "confirmed",
      "a late payment is still a payment — the merchant has the bitcoin",
    );
  });
});

describe("arithmetic safety", () => {
  it("never produces a fractional satoshi", () => {
    const result = decideInvoiceOutcome(
      invoice({ amountSatoshi: 333_333, underpaidTolerancePercent: 7 }),
      observed(310_000),
      NOW,
    );

    if ("remainingSatoshi" in result) {
      assert.ok(Number.isInteger(result.remainingSatoshi));
    }
  });

  it("handles the largest amount an invoice could hold", () => {
    const huge = 2_100_000_000_000_000;
    const result = decideInvoiceOutcome(
      invoice({ amountSatoshi: huge }),
      observed(huge),
      NOW,
    );

    assert.equal(result.status, "confirmed");
    assert.equal("overpaidSatoshi" in result && result.overpaidSatoshi, 0);
  });
});
