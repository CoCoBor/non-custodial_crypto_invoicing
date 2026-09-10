import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync } from "@scure/bip39";

import {
  derivePublicKeyFromMnemonic,
  generateRecoveryCredential,
  verifyRecoverySignature,
} from "../../src/security/recovery-credential.js";

ed.hashes.sha512 = sha512;

// The test plays the role of the client: only the client ever holds the
// mnemonic, so only the client can sign. The server only ever verifies.
function signAsClient(mnemonic: string, challenge: Buffer): Buffer {
  const privateKey = mnemonicToSeedSync(mnemonic).slice(0, 32);

  return Buffer.from(ed.sign(challenge, privateKey));
}

describe("generateRecoveryCredential", () => {
  it("produces a 12 word mnemonic", () => {
    // 128 bits of entropy. Short enough that a merchant will actually write it
    // down, which is the failure mode that loses accounts.
    assert.equal(generateRecoveryCredential().mnemonic.split(" ").length, 12);
  });

  it("produces a different mnemonic every time", () => {
    assert.notEqual(
      generateRecoveryCredential().mnemonic,
      generateRecoveryCredential().mnemonic,
    );
  });

  it("returns a public key that is safe to store", () => {
    assert.match(generateRecoveryCredential().publicKey, /^[A-Za-z0-9_-]+$/);
  });

  it("never leaks the mnemonic into the public key", () => {
    const credential = generateRecoveryCredential();

    for (const word of credential.mnemonic.split(" ")) {
      assert.ok(
        !credential.publicKey.includes(word),
        `the public key contained the word "${word}"`,
      );
    }
  });
});

describe("derivePublicKeyFromMnemonic", () => {
  it("rebuilds the same public key from the same mnemonic", () => {
    const credential = generateRecoveryCredential();

    assert.equal(
      derivePublicKeyFromMnemonic(credential.mnemonic),
      credential.publicKey,
    );
  });

  it("produces a different public key for a different mnemonic", () => {
    assert.notEqual(
      derivePublicKeyFromMnemonic(generateRecoveryCredential().mnemonic),
      derivePublicKeyFromMnemonic(generateRecoveryCredential().mnemonic),
    );
  });

  // Accounts created before the switch to 128 bits still hold a 24 word
  // phrase, and their public key has to keep deriving the same way.
  it("still derives from a valid 24 word mnemonic", () => {
    const legacy = `${new Array(23).fill("abandon").join(" ")} art`;

    assert.equal(
      derivePublicKeyFromMnemonic(legacy),
      "HeNS5EzTM2clk_IzSnMOGAqvKQ3omqFtSA3llONOKWE",
    );
  });

  it("derives a stable public key from a known 12 word vector", () => {
    const known = `${new Array(11).fill("abandon").join(" ")} about`;

    assert.equal(
      derivePublicKeyFromMnemonic(known),
      "xXheGGW3CJOK_4Fh1XMAZJZmOxqhCDTjltxWaGmixmo",
    );
  });

  it("returns undefined for a mnemonic that fails its checksum", () => {
    const twentyFourValidWords = new Array(24).fill("abandon").join(" ");

    assert.equal(derivePublicKeyFromMnemonic(twentyFourValidWords), undefined);
  });

  it("returns undefined for nonsense instead of throwing", () => {
    for (const input of ["", "hello world", "not a mnemonic at all"]) {
      assert.equal(derivePublicKeyFromMnemonic(input), undefined);
    }
  });
});

describe("verifyRecoverySignature", () => {
  it("accepts a signature made with the matching mnemonic", () => {
    const credential = generateRecoveryCredential();
    const challenge = Buffer.from("challenge-for-account-recovery");

    assert.equal(
      verifyRecoverySignature(
        credential.publicKey,
        challenge,
        signAsClient(credential.mnemonic, challenge),
      ),
      true,
    );
  });

  it("rejects a signature for a different challenge", () => {
    const credential = generateRecoveryCredential();
    const signature = signAsClient(
      credential.mnemonic,
      Buffer.from("challenge-one"),
    );

    assert.equal(
      verifyRecoverySignature(
        credential.publicKey,
        Buffer.from("challenge-two"),
        signature,
      ),
      false,
    );
  });

  it("rejects a signature made with a different mnemonic", () => {
    const credential = generateRecoveryCredential();
    const attacker = generateRecoveryCredential();
    const challenge = Buffer.from("challenge-for-account-recovery");

    assert.equal(
      verifyRecoverySignature(
        credential.publicKey,
        challenge,
        signAsClient(attacker.mnemonic, challenge),
      ),
      false,
    );
  });

  it("returns false for malformed input instead of throwing", () => {
    const credential = generateRecoveryCredential();
    const challenge = Buffer.from("challenge");

    assert.equal(
      verifyRecoverySignature(credential.publicKey, challenge, Buffer.alloc(0)),
      false,
    );
    assert.equal(
      verifyRecoverySignature(
        credential.publicKey,
        challenge,
        Buffer.alloc(64, 0xff),
      ),
      false,
    );
    assert.equal(
      verifyRecoverySignature("not-a-key", challenge, Buffer.alloc(64)),
      false,
    );
  });
});
