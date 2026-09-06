import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import {
  deriveDepositKey,
  parseExtendedPrivateKey,
} from "../../../src/chains/bitcoin/platform-key.js";
import {
  addressFromPublicKey,
  deriveReceiveAddress,
  parseExtendedPublicKey,
} from "../../../src/chains/bitcoin/extended-key.js";

// Every fixture below comes from the same well-known BIP-32 test mnemonic
// already used by extended-key.test.ts:
//   abandon abandon abandon abandon abandon abandon abandon abandon
//   abandon abandon abandon about
//
// The account keys sit at m/44'/0'/0', m/49'/0'/0' and m/84'/0'/0'.
// The addresses are the published vectors from BIP-44, BIP-49 and BIP-84 —
// the same values extended-key.test.ts already proves we can watch. Proving
// the private side reaches those same addresses is what says we can spend them.

const XPRV =
  "xprv9xpXFhFpqdQK3TmytPBqXtGSwS3DLjojFhTGht8gwAAii8py5X6pxeBnQ6ehJiyJ6nDjWGJfZ95WxByFXVkDxHXrqu53WCRGypk2ttuqncb";
const YPRV =
  "yprvAHwhK6RbpuS3dgCYHM5jc2ZvEKd7Bi61u9FVhYMpgMSuZS613T1xxQeKTffhrHY79hZ5PsskBjcc6C2V7DrnsMsNaGDaWev3GLRQRgV7hxF";
const ZPRV =
  "zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE";

// The m/84'/0'/0' account expressed as a public key — the same account as ZPRV.
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

const BIP44_ADDRESS_0 = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA";
const BIP49_ADDRESS_0 = "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf";
const BIP84_ADDRESS_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const BIP84_ADDRESS_1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";

// Raw private keys at m/84'/0'/0'/0/{0,1}, hex-encoded.
const BIP84_PRIVATE_KEY_0 =
  "4604b4b710fe91f584fff084e1a9159fe4f8408fff380596a604948474ce4fa3";
const BIP84_PRIVATE_KEY_1 =
  "2fd0affa51529f940a358ec0c50de81267d0bf5158ca61887347676946362c5b";

const MAX_NON_HARDENED_INDEX = 2_147_483_647; // 2^31 - 1

function parsedPrivate(key: string) {
  const account = parseExtendedPrivateKey(key);
  assert.ok(account, `expected ${key.slice(0, 4)} to parse`);

  return account;
}

function derived(key: string, index: number) {
  const deposit = deriveDepositKey(parsedPrivate(key), index);
  assert.ok(deposit, `expected a deposit key at index ${index}`);

  return deposit;
}

describe("parseExtendedPrivateKey", () => {
  it("reads the script type from the prefix, because the prefix decides the address format", () => {
    assert.equal(parsedPrivate(XPRV).scriptType, "p2pkh");
    assert.equal(parsedPrivate(YPRV).scriptType, "p2sh-p2wpkh");
    assert.equal(parsedPrivate(ZPRV).scriptType, "p2wpkh");
  });

  it("normalises the version bytes away, because @scure/bip32 rejects a zprv outright", () => {
    // Same m/84'/0'/0' account, already carrying xprv version bytes.
    const SAME_ACCOUNT_AS_XPRV =
      "xprv9ybY78BftS5UGANki6oSifuQEjkpyAC8ZmBvBNTshQnCBcxnefjHS7buPMkkqhcRzmoGZ5bokx7GuyDAiktd5HemohAU4wV1ZPMDRmLpBMm";

    assert.equal(
      parsedPrivate(ZPRV).key,
      parsedPrivate(SAME_ACCOUNT_AS_XPRV).key,
      "only the 4 version bytes differ, so both must normalise to one key",
    );
  });

  it("still treats those two as different, because the prefix carries meaning", () => {
    const SAME_ACCOUNT_AS_XPRV =
      "xprv9ybY78BftS5UGANki6oSifuQEjkpyAC8ZmBvBNTshQnCBcxnefjHS7buPMkkqhcRzmoGZ5bokx7GuyDAiktd5HemohAU4wV1ZPMDRmLpBMm";

    const asZprv = parsedPrivate(ZPRV);
    const asXprv = parsedPrivate(SAME_ACCOUNT_AS_XPRV);

    assert.notEqual(asZprv.scriptType, asXprv.scriptType);
    assert.notEqual(
      deriveDepositKey(asZprv, 0)?.address,
      deriveDepositKey(asXprv, 0)?.address,
      "identical key, different prefix, different address — the prefix must be stored",
    );
  });

  it("refuses a public extended key, because we could not sign and would not find out until sweep time", () => {
    for (const publicKey of [ZPUB, "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V"]) {
      assert.equal(
        parseExtendedPrivateKey(publicKey),
        undefined,
        "an xpub configured as the platform key derives payable addresses we can never spend from",
      );
    }
  });

  it("tolerates surrounding whitespace from a copy and paste", () => {
    assert.equal(parsedPrivate(`  ${ZPRV}\n`).key, parsedPrivate(ZPRV).key);
  });

  it("returns undefined for a key with a broken checksum", () => {
    assert.equal(parseExtendedPrivateKey(ZPRV.slice(0, -1) + "X"), undefined);
  });

  it("returns undefined for nonsense instead of throwing, so bad config cannot crash the process", () => {
    for (const input of ["", "not-a-key", "zprv", BIP84_ADDRESS_0]) {
      assert.equal(
        parseExtendedPrivateKey(input),
        undefined,
        `accepted or threw on ${JSON.stringify(input)}`,
      );
    }
  });
});

describe("deriveDepositKey", () => {
  it("matches the published BIP-84 vectors, so a real wallet reaches the same addresses", () => {
    assert.equal(derived(ZPRV, 0).address, BIP84_ADDRESS_0);
    assert.equal(derived(ZPRV, 1).address, BIP84_ADDRESS_1);
  });

  it("matches the published BIP-44 vector for an xprv", () => {
    assert.equal(derived(XPRV, 0).address, BIP44_ADDRESS_0);
  });

  it("matches the published BIP-49 vector for a yprv", () => {
    assert.equal(derived(YPRV, 0).address, BIP49_ADDRESS_0);
  });

  it("returns the published private keys, which is what proves we can spend", () => {
    assert.equal(bytesToHex(derived(ZPRV, 0).privateKey), BIP84_PRIVATE_KEY_0);
    assert.equal(bytesToHex(derived(ZPRV, 1).privateKey), BIP84_PRIVATE_KEY_1);
  });

  it("returns a 32-byte key, the size secp256k1 signing requires", () => {
    const { privateKey } = derived(ZPRV, 0);

    assert.ok(privateKey instanceof Uint8Array);
    assert.equal(privateKey.length, 32);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The invariant. If this ever fails, funds are sent to an address whose key
  // we do not hold, and they are unrecoverable.
  // ─────────────────────────────────────────────────────────────────────────
  it("agrees with the watch-only path at every index, so we can always spend what we showed the payer", () => {
    const privateAccount = parsedPrivate(ZPRV);
    const publicAccount = parseExtendedPublicKey(ZPUB);
    assert.ok(publicAccount);

    for (const index of [0, 1, 2, 7, 99, 1000, MAX_NON_HARDENED_INDEX]) {
      assert.equal(
        deriveDepositKey(privateAccount, index)?.address,
        deriveReceiveAddress(publicAccount, index),
        `address disagreement at index ${index} would strand funds permanently`,
      );
    }
  });

  it("gives a different key for every index, so invoices never share an address", () => {
    const account = parsedPrivate(ZPRV);
    const addresses = new Set<string>();
    const keys = new Set<string>();

    for (let index = 0; index < 25; index++) {
      const deposit = deriveDepositKey(account, index);
      assert.ok(deposit);
      addresses.add(deposit.address);
      keys.add(bytesToHex(deposit.privateKey));
    }

    assert.equal(addresses.size, 25, "addresses must never repeat across invoices");
    assert.equal(keys.size, 25, "keys must never repeat across invoices");
  });

  it("is deterministic, so a key can be recomputed from the index alone after a restart", () => {
    const account = parsedPrivate(ZPRV);
    const first = deriveDepositKey(account, 7);
    const second = deriveDepositKey(account, 7);

    assert.equal(first?.address, second?.address);
    assert.equal(bytesToHex(first!.privateKey), bytesToHex(second!.privateKey));
  });

  it("handles the highest non-hardened index without wrapping around", () => {
    const high = derived(ZPRV, MAX_NON_HARDENED_INDEX);

    assert.ok(high.address.startsWith("bc1q"));
    assert.notEqual(high.address, derived(ZPRV, 0).address);
  });

  it("rejects an index outside the non-hardened range, keeping a watch-only xpub possible", () => {
    const account = parsedPrivate(ZPRV);

    for (const index of [-1, 1.5, 2_147_483_648, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      assert.equal(
        deriveDepositKey(account, index),
        undefined,
        `index ${index} should be rejected: hardened derivation breaks watch-only derivation`,
      );
    }
  });
});

describe("addressFromPublicKey", () => {
  // Extracted from deriveReceiveAddress so that the watch-only path and the
  // spending path share one implementation. Two copies that drift apart would
  // show the payer one address while we hold the key to another.

  // The compressed public key at m/84'/0'/0'/0/0 of the test mnemonic.
  const PUBLIC_KEY = hexToBytes(
    "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c",
  );

  it("gives one key three different addresses, one per script type", () => {
    assert.equal(addressFromPublicKey(PUBLIC_KEY, "p2wpkh"), BIP84_ADDRESS_0);
    assert.equal(
      addressFromPublicKey(PUBLIC_KEY, "p2pkh"),
      "1JaUQDVNRdhfNsVncGkXedaPSM5Gc54Hso",
    );
    assert.equal(
      addressFromPublicKey(PUBLIC_KEY, "p2sh-p2wpkh"),
      "3GtVZYzsKF6Feikdjd4bDyPdAiyeHANY9b",
    );
  });

  it("is the same helper both derivation paths use", () => {
    const publicAccount = parseExtendedPublicKey(ZPUB);
    assert.ok(publicAccount);

    assert.equal(deriveReceiveAddress(publicAccount, 0), BIP84_ADDRESS_0);
    assert.equal(derived(ZPRV, 0).address, BIP84_ADDRESS_0);
    assert.equal(addressFromPublicKey(PUBLIC_KEY, "p2wpkh"), BIP84_ADDRESS_0);
  });

  it("returns undefined for a malformed public key instead of throwing", () => {
    // @scure/btc-signer throws "P2WPKH: invalid publicKey" on a bad length,
    // so the helper must catch. A verification function that throws on bad
    // input is a denial-of-service surface.
    assert.equal(addressFromPublicKey(new Uint8Array(0), "p2wpkh"), undefined);
    assert.equal(addressFromPublicKey(new Uint8Array(10), "p2wpkh"), undefined);
    assert.equal(addressFromPublicKey(new Uint8Array(33), "p2pkh"), undefined);
  });
});
