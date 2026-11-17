import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildTotpUri,
  generateTotpCode,
  generateTotpSecret,
  verifyTotpCode,
} from "../../src/security/totp.js";

// RFC 6238 Appendix B reference secret: the ASCII string "12345678901234567890"
// encoded as Base32. Every authenticator app must agree on these codes.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const RFC_VECTORS: Array<[unixSeconds: number, code: string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

const PERIOD_SECONDS = 30;

function at(unixSeconds: number): Date {
  return new Date(unixSeconds * 1000);
}

describe("generateTotpSecret", () => {
  it("uses only the base32 alphabet", () => {
    assert.match(generateTotpSecret(), /^[A-Z2-7]+=*$/);
  });

  it("carries at least 160 bits, as the rfc recommends", () => {
    // 160 bits / 5 bits per base32 character = 32 characters
    const withoutPadding = generateTotpSecret().replace(/=+$/, "");

    assert.ok(
      withoutPadding.length >= 32,
      `secret was only ${withoutPadding.length} characters`,
    );
  });

  it("never repeats", () => {
    assert.notEqual(generateTotpSecret(), generateTotpSecret());
  });
});

describe("generateTotpCode", () => {
  it("matches every rfc 6238 reference vector", () => {
    for (const [unixSeconds, expected] of RFC_VECTORS) {
      assert.equal(
        generateTotpCode(RFC_SECRET, at(unixSeconds)),
        expected,
        `wrong code at unix time ${unixSeconds}`,
      );
    }
  });

  it("is always six digits", () => {
    assert.match(generateTotpCode(generateTotpSecret()), /^[0-9]{6}$/);
  });

  it("keeps leading zeros instead of dropping them", () => {
    // 1234567890 falls in a window whose code starts with two zeros
    assert.equal(generateTotpCode(RFC_SECRET, at(1234567890)), "005924");
  });

  it("stays the same for the whole 30 second window", () => {
    const start = 1111111110; // step boundary
    const first = generateTotpCode(RFC_SECRET, at(start));

    assert.equal(generateTotpCode(RFC_SECRET, at(start + 29)), first);
  });

  it("changes when the window rolls over", () => {
    const start = 1111111110;

    assert.notEqual(
      generateTotpCode(RFC_SECRET, at(start)),
      generateTotpCode(RFC_SECRET, at(start + PERIOD_SECONDS)),
    );
  });

  it("gives different codes for different secrets at the same moment", () => {
    const moment = at(1111111111);

    assert.notEqual(
      generateTotpCode(generateTotpSecret(), moment),
      generateTotpCode(generateTotpSecret(), moment),
    );
  });
});

describe("verifyTotpCode", () => {
  const now = 1111111111;
  const currentStep = Math.floor(now / PERIOD_SECONDS);

  it("accepts the code for the current window and reports its step", () => {
    const code = generateTotpCode(RFC_SECRET, at(now));

    assert.equal(verifyTotpCode(RFC_SECRET, code, at(now)), currentStep);
  });

  it("accepts a code from the previous window, for a slow clock", () => {
    const code = generateTotpCode(RFC_SECRET, at(now - PERIOD_SECONDS));

    assert.equal(
      verifyTotpCode(RFC_SECRET, code, at(now)),
      currentStep - 1,
      "must report the step the code belonged to, not the current one",
    );
  });

  it("accepts a code from the next window, for a fast clock", () => {
    const code = generateTotpCode(RFC_SECRET, at(now + PERIOD_SECONDS));

    assert.equal(verifyTotpCode(RFC_SECRET, code, at(now)), currentStep + 1);
  });

  it("rejects a code two windows old", () => {
    const code = generateTotpCode(RFC_SECRET, at(now - 2 * PERIOD_SECONDS));

    assert.equal(verifyTotpCode(RFC_SECRET, code, at(now)), undefined);
  });

  it("rejects a code from a different secret", () => {
    const code = generateTotpCode(generateTotpSecret(), at(now));

    assert.equal(verifyTotpCode(RFC_SECRET, code, at(now)), undefined);
  });

  it("tolerates spaces, which authenticator apps display", () => {
    const code = generateTotpCode(RFC_SECRET, at(now));
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    assert.equal(verifyTotpCode(RFC_SECRET, spaced, at(now)), currentStep);
  });

  it("returns undefined for malformed input instead of throwing", () => {
    for (const bad of ["", "abcdef", "12345", "1234567", "!!!!!!"]) {
      assert.equal(
        verifyTotpCode(RFC_SECRET, bad, at(now)),
        undefined,
        `threw or accepted ${JSON.stringify(bad)}`,
      );
    }
  });

  it("returns undefined for a malformed secret instead of throwing", () => {
    assert.equal(verifyTotpCode("not base32!", "123456", at(now)), undefined);
  });

  it("gives a different step for each window, so replays can be detected", () => {
    const earlier = verifyTotpCode(
      RFC_SECRET,
      generateTotpCode(RFC_SECRET, at(now)),
      at(now),
    );
    const later = verifyTotpCode(
      RFC_SECRET,
      generateTotpCode(RFC_SECRET, at(now + PERIOD_SECONDS)),
      at(now + PERIOD_SECONDS),
    );

    assert.ok(earlier !== undefined && later !== undefined);
    assert.ok(
      later > earlier,
      "the step must increase over time for replay detection to work",
    );
  });
});

describe("buildTotpUri", () => {
  const uri = buildTotpUri("Crypto Invoicing", "1234-5678-9012-3456", RFC_SECRET);

  it("uses the otpauth scheme that qr codes encode", () => {
    assert.ok(uri.startsWith("otpauth://totp/"));
  });

  it("carries the secret, issuer, digits and period", () => {
    const parameters = new URL(uri).searchParams;

    assert.equal(parameters.get("secret"), RFC_SECRET);
    assert.equal(parameters.get("issuer"), "Crypto Invoicing");
    assert.equal(parameters.get("digits"), "6");
    assert.equal(parameters.get("period"), "30");
    assert.equal(parameters.get("algorithm"), "SHA1");
  });

  it("escapes the label so spaces and separators survive", () => {
    const spacey = buildTotpUri("My Company", "user name", RFC_SECRET);

    assert.ok(!spacey.split("?")[0]?.includes(" "), "the label must be encoded");
  });
});
