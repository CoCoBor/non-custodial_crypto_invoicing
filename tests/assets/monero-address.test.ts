import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPayoutAddress } from "../../src/assets/payout-address.js";
import { moneroAddressKind } from "../../src/chains/monero-address.js";

// The Monero rule: Monero's block-based base58, a mainnet network byte
// (18 standard, 42 subaddress, 19 integrated) and the first 4 bytes of
// Keccak-256 as the checksum.
//
// Every example address below is copied from Monero's own test suite,
// tests/functional_tests/validate_address.py and integrated_address.py in
// https://github.com/monero-project/monero (master, read 2026-11-18).

const STANDARD = [
  "42ey1afDFnn4886T7196doS9GPMzexD9gXpsZJDwVjeRVdFCSoHnv7KPbBeGpzJBzHRCAs9UxqeoyFQMYbqSWYTfJJQAWDm",
  "44Kbx4sJ7JDRDV5aAhLJzQCjDz2ViLRduE3ijDZu3osWKBjMGkV1XPk4pfDUMqt1Aiezvephdqm6YD19GKFD9ZcXVUTp6BW",
];
const SUBADDRESS = [
  "8AsN91rznfkBGTY8psSNkJBg9SZgxxGGRUhGwRptBhgr5XSQ1XzmA9m8QAnoxydecSh5aLJXdrgXwTDMMZ1AuXsN1EX5Mtm",
  "86kKnBKFqzCLxtK1Jmx2BkNBDBSMDEVaRYMMyVbeURYDWs8uNGDZURKCA5yRcyMxHzPcmCf1q2fSdhQVcaKsFrtGRsdGfNk",
  // getmonero.org's donation address (address_book.py resolves donate@getmonero.org to it).
  "888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H",
];
const INTEGRATED = [
  "4BxSHvcgTwu25WooY4BVmgdcKwZu5EksVZSZkDd6ooxSVVqQ4ubxXkhLF6hEqtw96i9cf3cVfLw8UWe95bdDKfRQeYtPwLm1Jiw7AKt2LY",
  "4CMe2PUhs4J4886T7196doS9GPMzexD9gXpsZJDwVjeRVdFCSoHnv7KPbBeGpzJBzHRCAs9UxqeoyFQMYbqSWYTfSbLRB61BQVATzerHGj",
];

describe("the Monero payout address check (xmr)", () => {
  it("accepts mainnet standard addresses (4…)", () => {
    for (const address of STANDARD) {
      assert.equal(checkPayoutAddress("xmr", address), "valid", address);
      assert.equal(moneroAddressKind(address), "standard", address);
    }
  });

  it("accepts mainnet subaddresses (8…)", () => {
    for (const address of SUBADDRESS) {
      assert.equal(checkPayoutAddress("xmr", address), "valid", address);
      assert.equal(moneroAddressKind(address), "subaddress", address);
    }
  });

  it("reads mainnet integrated addresses (4…, 106 characters) but refuses them for payouts", () => {
    // A payout pays the platform too, and monero-wallet-rpc can't build a
    // transaction to an integrated address with a second destination.
    for (const address of INTEGRATED) {
      assert.equal(moneroAddressKind(address), "integrated", address);
      assert.equal(checkPayoutAddress("xmr", address), "invalid", address);
    }
  });

  it("refuses a bad checksum", () => {
    // validate_address.py's own bad address: the last character changed.
    assert.equal(checkPayoutAddress("xmr", STANDARD[0]!.slice(0, -1) + "9"), "invalid");
    assert.equal(checkPayoutAddress("xmr", STANDARD[0]!.slice(0, -1) + "n"), "invalid");
    assert.equal(checkPayoutAddress("xmr", SUBADDRESS[0]!.slice(0, -2) + "mm"), "invalid");
    assert.equal(moneroAddressKind(INTEGRATED[0]!.replace("AKt2LY", "AKt2LZ")), undefined);
  });

  it("refuses testnet and stagenet addresses", () => {
    for (const address of [
      "9ujeXrjzf7bfeK3KZdCqnYaMwZVFuXemPU8Ubw335rj2FN1CdMiWNyFV3ksEfMFvRp9L9qum5UxkP5rN9aLcPxbH1au4WAB",
      "BdKg9udkvckC5T58a8Nmtb6BNsgRAxs7uA2D49sWNNX5HPW5Us6Wxu8QMXrnSx3xPBQQ2iu9kwEcRGAoiz6EPmcZKbF62GS",
      "AApMA1VuhiCaHzr5X2KXi2Zc9oJ3VaGjkfChxxpRpxkyKf1NetvbRbQTbFMrGkr85DjnEH7JsBaoUFsgKwZnmtnVWnoB8MDotCsLb7eWwz",
      "53teqCAESLxeJ1REzGMAat1ZeHvuajvDiXqboEocPaDRRmqWoVPzy46GLo866qRFjbNhfkNckyhST3WEvBviDwpUDd7DSzB",
      "73LhUiix4DVFMcKhsPRG51QmCsv8dYYbL6GcQoLwEEFvPvkVvc7BhebfA4pnEFF9Lq66hwvLqBvpHjTcqvpJMHmmNjPPBqa",
      "5K8mwfjumVseCcQEjNbf59Um6R9NfVUNkHTLhhPCmNvgDLVS88YW5tScnm83rw9mfgYtchtDDTW5jEfMhygi27j1QYphX38hg6m4VMtN29",
    ]) {
      assert.equal(checkPayoutAddress("xmr", address), "invalid", address);
      assert.equal(moneroAddressKind(address), undefined, address);
    }
  });

  it("refuses other chains' addresses, wrong lengths and empty input", () => {
    assert.equal(checkPayoutAddress("xmr", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"), "invalid");
    assert.equal(checkPayoutAddress("xmr", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"), "invalid");
    assert.equal(checkPayoutAddress("xmr", "0x000000000000000000000000000000000000dEaD"), "invalid");
    assert.equal(checkPayoutAddress("xmr", STANDARD[0]!.slice(0, -1)), "invalid");
    assert.equal(checkPayoutAddress("xmr", STANDARD[0]! + "1"), "invalid");
    assert.equal(checkPayoutAddress("xmr", ` ${STANDARD[0]!}`), "invalid");
    assert.equal(checkPayoutAddress("xmr", "42ey"), "invalid");
    assert.equal(checkPayoutAddress("xmr", ""), "invalid");
    assert.equal(checkPayoutAddress("xmr", null), "invalid");
  });

  it("refuses a block that overflows its byte size", () => {
    // A standard address ends in a 7-character block that holds 5 bytes;
    // "zzzzzzz" is above 2^40, so the address must not decode at all.
    assert.equal(moneroAddressKind(STANDARD[0]!.slice(0, 88) + "zzzzzzz"), undefined);
  });
});
