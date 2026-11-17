import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ASSET_IDS } from "../../src/assets/payout-address.js";
import { User } from "../../src/database/users.model.js";

// Adding a coin to cryptos.json must also give merchants somewhere to save
// its payout and refund addresses.
describe("the coin list and the merchant's addresses", () => {
  for (const kind of ["payout_addresses", "refund_addresses"]) {
    it(`has a ${kind} field for every listed coin, and no others`, () => {
      const fields = Object.keys(User.schema.paths)
        .filter((path) => path.startsWith(`${kind}.`))
        .map((path) => path.slice(kind.length + 1))
        .sort();

      assert.deepEqual(fields, [...ASSET_IDS].sort());
    });
  }
});
