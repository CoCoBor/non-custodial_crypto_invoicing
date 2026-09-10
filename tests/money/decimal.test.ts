import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDecimalToScaledInteger } from "../../src/money/decimal.js";

describe("scaling a well-formed decimal", () => {
  it("multiplies a whole number by the scale", () => {
    assert.equal(parseDecimalToScaledInteger("1", 8), 100_000_000n);
  });

  it("keeps every fraction digit, so 0.001 BTC is exactly 100000 satoshi", () => {
    assert.equal(parseDecimalToScaledInteger("0.001", 8), 100_000n);
  });

  it("scales zero to zero rather than rejecting it", () => {
    assert.equal(parseDecimalToScaledInteger("0", 8), 0n);
    assert.equal(parseDecimalToScaledInteger("0.00", 2), 0n);
  });

  it("pads a fraction shorter than the scale, so 65432.1 is 6543210 cents", () => {
    assert.equal(parseDecimalToScaledInteger("65432.1", 2), 6_543_210n);
  });

  it("accepts a fraction exactly as long as the scale", () => {
    assert.equal(parseDecimalToScaledInteger("65432.10", 2), 6_543_210n);
  });

  it("scales by nothing when the scale is zero", () => {
    assert.equal(parseDecimalToScaledInteger("100", 0), 100n);
  });

  it("ignores surrounding whitespace, which arrives from form fields", () => {
    assert.equal(parseDecimalToScaledInteger("  1.5  ", 2), 150n);
  });

  it("accepts leading zeros without treating them as octal", () => {
    assert.equal(parseDecimalToScaledInteger("007.5", 2), 750n);
  });

  it("is exact past Number.MAX_SAFE_INTEGER, which is the reason it returns bigint", () => {
    assert.equal(
      parseDecimalToScaledInteger("12345678901234567890.12345678", 8),
      1234567890123456789012345678n,
    );
  });
});

describe("rejecting a value that cannot be trusted", () => {
  it("rejects more fraction digits than the scale allows, rather than truncating", () => {
    // Truncating here would silently discard money. The caller must decide.
    assert.equal(parseDecimalToScaledInteger("0.123456789", 8), undefined);
    assert.equal(parseDecimalToScaledInteger("100.005", 2), undefined);
    assert.equal(parseDecimalToScaledInteger("100.0", 0), undefined);
  });

  it("rejects a missing integer or fraction part", () => {
    assert.equal(parseDecimalToScaledInteger(".5", 8), undefined);
    assert.equal(parseDecimalToScaledInteger("5.", 8), undefined);
  });

  it("rejects exponent notation, which Number would happily accept", () => {
    assert.equal(parseDecimalToScaledInteger("1e3", 8), undefined);
    assert.equal(parseDecimalToScaledInteger("1E3", 8), undefined);
  });

  it("rejects signs, because no money field here is ever negative", () => {
    assert.equal(parseDecimalToScaledInteger("-1", 8), undefined);
    assert.equal(parseDecimalToScaledInteger("+1", 8), undefined);
    assert.equal(parseDecimalToScaledInteger("-0.5", 8), undefined);
  });

  it("rejects anything that is not digits and one dot", () => {
    for (const value of [
      "",
      "   ",
      "abc",
      "1.2.3",
      "1,000",
      "0x10",
      "Infinity",
      "NaN",
      "1 000",
      "١٢٣",
    ]) {
      assert.equal(
        parseDecimalToScaledInteger(value, 8),
        undefined,
        `expected ${JSON.stringify(value)} to be rejected`,
      );
    }
  });
});

describe("an impossible scale is a programming error, not bad input", () => {
  // The conventions split these deliberately: return undefined when the caller
  // can reasonably continue, throw when something is genuinely wrong. A bad
  // scale comes from our own code, never from a request body.
  it("throws rather than returning undefined", () => {
    for (const scale of [-1, 1.5, 37, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => parseDecimalToScaledInteger("1", scale),
        `expected scale ${scale} to throw`,
      );
    }
  });

  it("allows the full range a config decimals field can hold", () => {
    assert.equal(parseDecimalToScaledInteger("1", 0), 1n);
    assert.equal(parseDecimalToScaledInteger("1", 36), 10n ** 36n);
  });
});
