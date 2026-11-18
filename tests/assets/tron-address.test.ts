import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPayoutAddress } from "../../src/assets/payout-address.js";
import { tronAddressFromEvm, evmFormOfTronAddress } from "../../src/chains/tron-address.js";

// The Tron rule: base58check of 0x41 + 20 bytes ("T…", 34 characters).

const VALID = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

describe("the Tron payout address check (usdttrx)", () => {
  it("accepts a mainnet base58check address", () => {
    assert.equal(checkPayoutAddress("usdttrx", VALID), "valid");
    assert.equal(checkPayoutAddress("usdttrx", "TVzYu8aczxtWAF2JmcEZEUapsYqtUWDU1p"), "valid");
  });

  it("refuses a bad checksum", () => {
    assert.equal(checkPayoutAddress("usdttrx", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"), "invalid");
    assert.equal(checkPayoutAddress("usdttrx", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj7t"), "invalid");
  });

  it("refuses the hex form, an EVM address and other chains' addresses", () => {
    assert.equal(checkPayoutAddress("usdttrx", "41a614f803b6fd780986a42c78ec9c7f77e6ded13c"), "invalid");
    assert.equal(checkPayoutAddress("usdttrx", "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c"), "invalid");
    assert.equal(checkPayoutAddress("usdttrx", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"), "invalid");
    assert.equal(checkPayoutAddress("usdttrx", "UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_"), "invalid");
  });

  it("refuses wrong lengths, a wrong prefix byte, the zero address and empty input", () => {
    assert.equal(checkPayoutAddress("usdttrx", VALID.slice(0, -1)), "invalid");
    assert.equal(checkPayoutAddress("usdttrx", VALID + "1"), "invalid");
    // Valid base58check, but version byte 0x00 (a Bitcoin P2PKH address).
    assert.equal(checkPayoutAddress("usdttrx", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"), "invalid");
    assert.equal(checkPayoutAddress("usdttrx", "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"), "invalid");
    assert.equal(checkPayoutAddress("usdttrx", ""), "invalid");
    assert.equal(checkPayoutAddress("usdttrx", null), "invalid");
  });

  it("maps to and from the EVM form of the same 20 bytes", () => {
    const evm = evmFormOfTronAddress(VALID)!;
    assert.equal(evm.toLowerCase(), "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c");
    assert.equal(tronAddressFromEvm(evm), VALID);
  });
});
