import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeBlindIndex } from "../../src/security/blind-index.js";

const VALUE = "1234567890123456";
const NEARLY_THE_SAME = "1234567890123457";

describe("computeBlindIndex", () => {
  it("is deterministic, so it can be used as a lookup key", () => {
    assert.equal(
      computeBlindIndex("account-number", VALUE),
      computeBlindIndex("account-number", VALUE),
    );
  });

  it("produces a different index for a different value", () => {
    assert.notEqual(
      computeBlindIndex("account-number", VALUE),
      computeBlindIndex("account-number", NEARLY_THE_SAME),
    );
  });

  it("separates every purpose from every other", () => {
    const indexes = new Set([
      computeBlindIndex("account-number", VALUE),
      computeBlindIndex("api-key", VALUE),
      computeBlindIndex("recovery-public-key", VALUE),
    ]);

    assert.equal(indexes.size, 3);
  });

  it("does not contain the raw value", () => {
    assert.ok(!computeBlindIndex("account-number", VALUE).includes(VALUE));
  });

  it("is safe to use in urls and database keys", () => {
    assert.match(computeBlindIndex("account-number", VALUE), /^[A-Za-z0-9_-]+$/);
  });

  it("is 43 characters regardless of input length", () => {
    assert.equal(computeBlindIndex("account-number", "1").length, 43);
    assert.equal(
      computeBlindIndex("account-number", "a".repeat(5_000)).length,
      43,
    );
  });

  it("changes almost entirely when one digit changes", () => {
    const index = computeBlindIndex("account-number", VALUE);
    const other = computeBlindIndex("account-number", NEARLY_THE_SAME);

    let differing = 0;
    for (let position = 0; position < index.length; position += 1) {
      if (index[position] !== other[position]) {
        differing += 1;
      }
    }

    assert.ok(
      differing > index.length * 0.5,
      `only ${differing} of ${index.length} characters differed`,
    );
  });
});
