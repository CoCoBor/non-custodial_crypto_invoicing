import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseBitcoinAddress } from "../../../src/chains/bitcoin/address.js";

// This is where a merchant's money ends up. An address accepted here and
// wrong is not a validation bug — it is a payment sent somewhere nobody can
// reach. Everything below is a real mainnet address of its type.

const P2PKH = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA";
const P2SH = "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf";
const P2WPKH = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const P2TR =
  "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";

function parsed(input: string) {
  const address = parseBitcoinAddress(input);
  assert.ok(address, `expected ${input.slice(0, 12)}… to parse`);

  return address;
}

describe("parseBitcoinAddress", () => {
  it("accepts every mainnet address type a merchant might hold", () => {
    assert.equal(parsed(P2PKH).type, "p2pkh");
    assert.equal(parsed(P2SH).type, "p2sh");
    assert.equal(parsed(P2WPKH).type, "p2wpkh");
    assert.equal(parsed(P2TR).type, "p2tr");
  });

  it("returns the address back, so the caller stores a checked value", () => {
    assert.equal(parsed(P2WPKH).address, P2WPKH);
  });

  it("tolerates whitespace from a copy and paste, which the decoder does not", () => {
    // @scure/btc-signer throws on a leading space or a trailing newline.
    assert.equal(parsed(`  ${P2WPKH}  `).address, P2WPKH);
    assert.equal(parsed(`${P2WPKH}\n`).address, P2WPKH);
    assert.equal(parsed(`\t${P2PKH}\n`).address, P2PKH);
  });

  // ── case rules differ by encoding, and getting this wrong loses money ──
  it("lowercases an uppercase bech32 address, because both spell the same address", () => {
    // BIP-173 permits all-uppercase, and QR codes use it. Storing two
    // spellings of one address makes later comparison unreliable.
    const upper = P2WPKH.toUpperCase();

    assert.equal(parsed(upper).address, P2WPKH);
    assert.equal(parsed(upper).type, "p2wpkh");
  });

  it("preserves base58 case, where lowercasing would produce a different address", () => {
    // Base58 is case-sensitive: "1LqBGS…" and "1lqbgs…" are not the same
    // string, and only one of them has a valid checksum.
    assert.equal(parsed(P2PKH).address, P2PKH);
    assert.equal(parsed(P2SH).address, P2SH);
    assert.equal(parseBitcoinAddress(P2PKH.toLowerCase()), undefined);
  });

  it("rejects a mixed-case bech32 address, as the specification requires", () => {
    assert.equal(
      parseBitcoinAddress("bc1QcR8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
      undefined,
    );
  });

  // ── wrong network ──────────────────────────────────────────────────────
  it("rejects addresses from other networks, which are unspendable on mainnet", () => {
    assert.equal(
      parseBitcoinAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"),
      undefined,
      "testnet",
    );
    assert.equal(
      parseBitcoinAddress("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"),
      undefined,
      "regtest",
    );
    assert.equal(
      parseBitcoinAddress("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn"),
      undefined,
      "testnet base58",
    );
  });

  // ── malformed input never throws ───────────────────────────────────────
  it("returns undefined for anything malformed instead of throwing", () => {
    const rejected = [
      "",
      "   ",
      "not-an-address",
      "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabX", // bad checksum
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv", // bad bech32 checksum
      "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", // an ethereum address
      "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V",
      "bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", // a URI, not an address
    ];

    for (const input of rejected) {
      assert.equal(
        parseBitcoinAddress(input),
        undefined,
        `accepted or threw on ${JSON.stringify(input.slice(0, 24))}`,
      );
    }
  });
});
