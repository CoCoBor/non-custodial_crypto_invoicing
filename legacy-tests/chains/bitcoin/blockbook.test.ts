import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAddressActivity } from "../../../src/chains/bitcoin/blockbook.js";

const ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

/** A real response from NOWNodes with details=txslight, trimmed. */
const WITH_UNCONFIRMED = {
  page: 1,
  totalPages: 88,
  itemsOnPage: 2,
  address: ADDRESS,
  balance: "0",
  totalReceived: "4082661",
  totalSent: "4082661",
  unconfirmedBalance: "0",
  unconfirmedTxs: 0,
  txs: 176,
  transactions: [],
};

/** A real response from NOWNodes with details=basic — note the missing field. */
const WITHOUT_UNCONFIRMED = {
  address: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  balance: "24859759222608",
  totalReceived: "119037530149216",
  totalSent: "94177770926608",
  unconfirmedTxs: 0,
  txs: 1_050_000,
};

describe("parseAddressActivity on real responses", () => {
  it("reads the address back", () => {
    assert.equal(parseAddressActivity(WITH_UNCONFIRMED)?.address, ADDRESS);
  });

  it("converts the satoshi strings into numbers", () => {
    const activity = parseAddressActivity(WITH_UNCONFIRMED);

    assert.equal(activity?.confirmedSatoshi, 4_082_661);
    assert.equal(typeof activity?.confirmedSatoshi, "number");
  });

  it("treats a missing unconfirmedBalance as nothing pending", () => {
    const activity = parseAddressActivity(WITHOUT_UNCONFIRMED);

    assert.equal(
      activity?.pendingSatoshi,
      0,
      "the field is absent with details=basic — that must not become NaN",
    );
  });

  it("reads a pending amount when the field is present", () => {
    const activity = parseAddressActivity({
      ...WITH_UNCONFIRMED,
      unconfirmedBalance: "125000",
      unconfirmedTxs: 1,
    });

    assert.equal(activity?.pendingSatoshi, 125_000);
    assert.equal(activity?.unconfirmedTxCount, 1);
  });

  it("clamps a negative unconfirmed balance to zero", () => {
    const activity = parseAddressActivity({
      ...WITH_UNCONFIRMED,
      unconfirmedBalance: "-50000",
      unconfirmedTxs: 1,
    });

    assert.equal(
      activity?.pendingSatoshi,
      0,
      "a negative balance means the merchant is spending, not that a payer owes less",
    );
  });

  it("handles a very large but still safe amount", () => {
    const activity = parseAddressActivity(WITHOUT_UNCONFIRMED);

    assert.equal(activity?.confirmedSatoshi, 119_037_530_149_216);
  });
});

describe("parseAddressActivity refuses what it cannot trust", () => {
  it("rejects a value too large to hold exactly", () => {
    const activity = parseAddressActivity({
      ...WITH_UNCONFIRMED,
      totalReceived: "99999999999999999999",
    });

    assert.equal(
      activity,
      undefined,
      "beyond Number.MAX_SAFE_INTEGER the value silently loses precision",
    );
  });

  it("rejects a totalReceived that is not digits", () => {
    for (const totalReceived of ["", "abc", "1.5", "1e6", "-1"]) {
      assert.equal(
        parseAddressActivity({ ...WITH_UNCONFIRMED, totalReceived }),
        undefined,
        `accepted totalReceived ${JSON.stringify(totalReceived)}`,
      );
    }
  });

  it("rejects a numeric totalReceived, because the api sends strings", () => {
    assert.equal(
      parseAddressActivity({ ...WITH_UNCONFIRMED, totalReceived: 4_082_661 }),
      undefined,
      "a shape change like this is exactly what validation is for",
    );
  });

  it("rejects a response with no address", () => {
    const { address, ...rest } = WITH_UNCONFIRMED;

    assert.equal(parseAddressActivity(rest), undefined);
  });

  it("rejects an error payload from the provider", () => {
    assert.equal(parseAddressActivity({ error: "Invalid address" }), undefined);
  });

  it("rejects anything that is not an object", () => {
    for (const payload of [null, undefined, "", 0, [], "not json"]) {
      assert.equal(
        parseAddressActivity(payload),
        undefined,
        `accepted ${JSON.stringify(payload)}`,
      );
    }
  });

  it("never throws, whatever it is handed", () => {
    const nasty = { totalReceived: { $ne: null }, address: [], unconfirmedTxs: "many" };

    assert.doesNotThrow(() => parseAddressActivity(nasty));
    assert.equal(parseAddressActivity(nasty), undefined);
  });
});

describe("the shape it produces", () => {
  it("gives exactly the fields the outcome function needs", () => {
    const activity = parseAddressActivity(WITH_UNCONFIRMED);

    assert.deepEqual(Object.keys(activity!).sort(), [
      "address",
      "confirmedSatoshi",
      "pendingSatoshi",
      "unconfirmedTxCount",
    ]);
  });

  it("produces integers, never floats", () => {
    const activity = parseAddressActivity(WITH_UNCONFIRMED)!;

    assert.ok(Number.isInteger(activity.confirmedSatoshi));
    assert.ok(Number.isInteger(activity.pendingSatoshi));
    assert.ok(Number.isInteger(activity.unconfirmedTxCount));
  });
});
