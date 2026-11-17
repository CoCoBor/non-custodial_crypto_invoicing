import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatAccountNumberForDisplay,
  generateAccountNumber,
  generateApiKey,
  generateSessionToken,
  hashBearerToken,
  normaliseAccountNumber,
} from "../../src/security/secret-generator.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateAccountNumber", () => {
  it("is exactly 16 digits", () => {
    assert.match(generateAccountNumber(), /^[0-9]{16}$/);
  });

  it("is a string, so leading zeros and large values survive", () => {
    assert.equal(typeof generateAccountNumber(), "string");
  });

  it("does not repeat", () => {
    assert.notEqual(generateAccountNumber(), generateAccountNumber());
  });

  it("does not favour digits 0-5 the way modulo bias would", () => {
    const counts = new Array<number>(10).fill(0);

    for (let sample = 0; sample < 30_000; sample += 1) {
      for (const digit of generateAccountNumber()) {
        counts[Number(digit)] += 1;
      }
    }

    const low = counts.slice(0, 6).reduce((total, n) => total + n, 0) / 6;
    const high = counts.slice(6).reduce((total, n) => total + n, 0) / 4;
    const ratio = low / high;

    assert.ok(
      ratio < 1.01,
      `ratio was ${ratio.toFixed(4)}; randomBytes(1) % 10 would give about 1.04`,
    );
  });
});

describe("normaliseAccountNumber", () => {
  it("accepts a plain 16 digit string", () => {
    assert.equal(normaliseAccountNumber("1234567890123456"), "1234567890123456");
  });

  it("preserves leading zeros", () => {
    assert.equal(normaliseAccountNumber("0000000000000001"), "0000000000000001");
  });

  it("preserves values above Number.MAX_SAFE_INTEGER", () => {
    assert.equal(normaliseAccountNumber("9999999999999999"), "9999999999999999");
  });

  it("accepts dashes and spaces from copy and paste", () => {
    assert.equal(normaliseAccountNumber("1234-5678-9012-3456"), "1234567890123456");
    assert.equal(normaliseAccountNumber("1234 5678 9012 3456"), "1234567890123456");
  });

  it("rejects anything that is not 16 digits", () => {
    for (const input of [
      "",
      "123456789012345",
      "12345678901234567",
      "123456789012345a",
      "abcdefghijklmnop",
    ]) {
      assert.equal(normaliseAccountNumber(input), undefined, `accepted ${input}`);
    }
  });
});

describe("formatAccountNumberForDisplay", () => {
  it("groups the digits in fours", () => {
    assert.equal(
      formatAccountNumberForDisplay("1234567890123456"),
      "1234-5678-9012-3456",
    );
  });

  it("round trips through normalisation", () => {
    const accountNumber = generateAccountNumber();

    assert.equal(
      normaliseAccountNumber(formatAccountNumberForDisplay(accountNumber)),
      accountNumber,
    );
  });
});

describe("generateApiKey", () => {
  it("is a uuid v4, as the specification requires", () => {
    assert.match(generateApiKey(), UUID_V4);
  });

  it("does not repeat", () => {
    assert.notEqual(generateApiKey(), generateApiKey());
  });
});

describe("generateSessionToken", () => {
  it("carries 32 bytes of randomness", () => {
    assert.equal(generateSessionToken().length, 43);
  });

  it("is safe to put in a cookie or url", () => {
    assert.match(generateSessionToken(), /^[A-Za-z0-9_-]+$/);
  });

  it("does not repeat", () => {
    assert.notEqual(generateSessionToken(), generateSessionToken());
  });
});

describe("hashBearerToken", () => {
  it("is deterministic, so a stored hash can be looked up", () => {
    assert.equal(hashBearerToken("token"), hashBearerToken("token"));
  });

  it("differs for different tokens", () => {
    assert.notEqual(hashBearerToken("a"), hashBearerToken("b"));
  });

  it("does not contain the token", () => {
    const token = generateSessionToken();

    assert.ok(!hashBearerToken(token).includes(token));
  });
});
