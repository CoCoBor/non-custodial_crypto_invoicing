import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSmallestUnit } from "../../../src/money/format.js";
import { buildPaymentUri } from "../../../src/routes/invoice/payment-uri.js";

// The decimal string is built by padding and slicing an integer rather than
// dividing by a power of ten. Division produces exponential notation for small
// amounts, and an exponential amount in a BIP-21 URI is not a valid URI:
//
//        1 satoshi / 1e8  ->  "1e-8"
//       10 satoshi / 1e8  ->  "1e-7"
//
// A payer's wallet parsing that either errors or, worse, reads a wrong amount.

describe("formatSmallestUnit", () => {
  it("keeps small amounts in decimal notation, where dividing would go exponential", () => {
    assert.equal(formatSmallestUnit(1, 8), "0.00000001");
    assert.equal(formatSmallestUnit(10, 8), "0.0000001");
    assert.equal(formatSmallestUnit(546, 8), "0.00000546");
  });

  it("formats whole and fractional coins", () => {
    assert.equal(formatSmallestUnit(100_000_000, 8), "1");
    assert.equal(formatSmallestUnit(50_000_000, 8), "0.5");
    assert.equal(formatSmallestUnit(150_000_000, 8), "1.5");
    assert.equal(formatSmallestUnit(123_456_789, 8), "1.23456789");
  });

  it("trims trailing zeroes, because 0.50000000 and 0.5 are the same amount", () => {
    assert.equal(formatSmallestUnit(50_000_000, 8), "0.5");
    assert.equal(formatSmallestUnit(120_000_000, 8), "1.2");
  });

  it("formats zero as a bare zero", () => {
    assert.equal(formatSmallestUnit(0, 8), "0");
  });

  it("handles the whole bitcoin supply, which still fits a JS number", () => {
    // 21,000,000 BTC in satoshi is 2.1e15, under the 9.007e15 safe ceiling.
    assert.equal(formatSmallestUnit(2_100_000_000_000_000, 8), "21000000");
  });

  // This is why `decimals` lives in the config table per network rather than
  // being a constant: USDT is 6 decimals on Ethereum and 18 on BNB Chain.
  it("uses the decimals it is given, not a bitcoin assumption", () => {
    assert.equal(formatSmallestUnit(1_000_000, 6), "1");
    assert.equal(formatSmallestUnit(1_500_000, 6), "1.5");
    assert.equal(formatSmallestUnit(1, 6), "0.000001");
    assert.equal(formatSmallestUnit(42, 0), "42");
  });

  it("throws on an amount that cannot be represented exactly", () => {
    // Past this point integer arithmetic silently stops being exact, so a
    // formatted amount would not match what was actually owed.
    assert.throws(() => formatSmallestUnit(Number.MAX_SAFE_INTEGER + 2, 8));
    assert.throws(() => formatSmallestUnit(1.5, 8));
    assert.throws(() => formatSmallestUnit(-1, 8));
    assert.throws(() => formatSmallestUnit(Number.NaN, 8));
  });

  it("throws on impossible decimals", () => {
    assert.throws(() => formatSmallestUnit(100, -1));
    assert.throws(() => formatSmallestUnit(100, 1.5));
  });
});

describe("buildPaymentUri", () => {
  it("produces a BIP-21 URI a wallet can parse", () => {
    assert.equal(
      buildPaymentUri("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", 50_000_000),
      "bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=0.5",
    );
  });

  it("keeps a dust-sized amount readable rather than exponential", () => {
    assert.equal(
      buildPaymentUri("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", 546),
      "bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=0.00000546",
    );
  });

  it("takes bitcoin's decimals from the asset table, not a literal", () => {
    // If cryptos.json ever said something other than 8 for bitcoin, this
    // would change with it — which is the point of the field existing.
    assert.equal(
      buildPaymentUri("bc1qtest", 100_000_000),
      "bitcoin:bc1qtest?amount=1",
    );
  });
});
