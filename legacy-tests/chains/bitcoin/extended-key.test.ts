import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveReceiveAddress,
  parseExtendedPublicKey,
} from "../../../src/chains/bitcoin/extended-key.js";

// Every fixture below comes from the same well-known BIP-32 test mnemonic:
//   abandon abandon abandon abandon abandon abandon abandon abandon
//   abandon abandon abandon about
// The addresses are the published vectors from BIP-44, BIP-49 and BIP-84.

const XPUB =
  "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";
const YPUB =
  "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP";
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

const BIP44_ADDRESS_0 = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA";
const BIP49_ADDRESS_0 = "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf";
const BIP84_ADDRESS_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const BIP84_ADDRESS_1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";

function parsed(key: string) {
  const account = parseExtendedPublicKey(key);
  assert.ok(account, `expected ${key.slice(0, 4)} to parse`);

  return account;
}

describe("parseExtendedPublicKey", () => {
  it("reads the script type from the prefix", () => {
    assert.equal(parsed(XPUB).scriptType, "p2pkh");
    assert.equal(parsed(YPUB).scriptType, "p2sh-p2wpkh");
    assert.equal(parsed(ZPUB).scriptType, "p2wpkh");
  });

  it("normalises the version bytes away, keeping the key itself", () => {
    // The same m/84'/0'/0' account, re-encoded with xpub version bytes.
    const SAME_ACCOUNT_AS_XPUB =
      "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";

    assert.equal(
      parsed(ZPUB).key,
      parsed(SAME_ACCOUNT_AS_XPUB).key,
      "only the 4 version bytes differ, so both must normalise to one key",
    );
  });

  it("still treats those two as different, because the prefix carries meaning", () => {
    const SAME_ACCOUNT_AS_XPUB =
      "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";

    const asZpub = parsed(ZPUB);
    const asXpub = parsed(SAME_ACCOUNT_AS_XPUB);

    assert.notEqual(asZpub.scriptType, asXpub.scriptType);
    assert.notEqual(
      deriveReceiveAddress(asZpub, 0),
      deriveReceiveAddress(asXpub, 0),
      "identical key, different prefix, different address — this is why the prefix must be stored",
    );
  });

  it("tolerates surrounding whitespace from a copy and paste", () => {
    assert.equal(parsed(`  ${ZPUB}\n`).key, parsed(ZPUB).key);
  });

  it("returns undefined for a key with a broken checksum", () => {
    assert.equal(parseExtendedPublicKey(ZPUB.slice(0, -1) + "X"), undefined);
  });

  it("returns undefined for nonsense instead of throwing", () => {
    for (const input of ["", "not-a-key", "xpub", "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"]) {
      assert.equal(
        parseExtendedPublicKey(input),
        undefined,
        `accepted or threw on ${JSON.stringify(input)}`,
      );
    }
  });

  it("refuses a private extended key, which must never be sent to us", () => {
    const XPRV =
      "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu";

    assert.equal(
      parseExtendedPublicKey(XPRV),
      undefined,
      "a merchant pasting an xprv is handing over spending authority — reject it",
    );
  });
});

describe("deriveReceiveAddress", () => {
  it("matches the published BIP-84 vectors for a zpub", () => {
    const account = parsed(ZPUB);

    assert.equal(deriveReceiveAddress(account, 0), BIP84_ADDRESS_0);
    assert.equal(deriveReceiveAddress(account, 1), BIP84_ADDRESS_1);
  });

  it("matches the published BIP-44 vector for an xpub", () => {
    assert.equal(deriveReceiveAddress(parsed(XPUB), 0), BIP44_ADDRESS_0);
  });

  it("matches the published BIP-49 vector for a ypub", () => {
    assert.equal(deriveReceiveAddress(parsed(YPUB), 0), BIP49_ADDRESS_0);
  });

  it("produces the address format the merchant's wallet is watching", () => {
    assert.match(deriveReceiveAddress(parsed(XPUB), 0)!, /^1/);
    assert.match(deriveReceiveAddress(parsed(YPUB), 0)!, /^3/);
    assert.match(deriveReceiveAddress(parsed(ZPUB), 0)!, /^bc1q/);
  });

  it("gives a different address for every index", () => {
    const account = parsed(ZPUB);
    const addresses = new Set(
      Array.from({ length: 25 }, (_, index) => deriveReceiveAddress(account, index)),
    );

    assert.equal(addresses.size, 25, "addresses must never repeat across invoices");
  });

  it("is deterministic, so an address can be recomputed from the index alone", () => {
    const account = parsed(ZPUB);

    assert.equal(deriveReceiveAddress(account, 7), deriveReceiveAddress(account, 7));
  });

  it("handles a large index without wrapping around", () => {
    const account = parsed(ZPUB);
    const high = deriveReceiveAddress(account, 2_147_483_647);

    assert.ok(high?.startsWith("bc1q"));
    assert.notEqual(high, deriveReceiveAddress(account, 0));
  });

  it("returns undefined for an index outside the non-hardened range", () => {
    const account = parsed(ZPUB);

    for (const index of [-1, 1.5, 2_147_483_648, Number.NaN]) {
      assert.equal(
        deriveReceiveAddress(account, index),
        undefined,
        `index ${index} should be rejected: hardened derivation is impossible from a public key`,
      );
    }
  });
});
