import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  openSecret,
  sealSecret,
} from "../../src/security/secret-envelope.js";

const PLAINTEXT = "1234567890123456";

describe("sealSecret", () => {
  it("uses a 12 byte initialisation vector", () => {
    assert.equal(
      sealSecret("account-number", PLAINTEXT).initialisationVector.length,
      12,
    );
  });

  it("produces a 16 byte authentication tag", () => {
    assert.equal(
      sealSecret("account-number", PLAINTEXT).authenticationTag.length,
      16,
    );
  });

  it("records the key version", () => {
    assert.equal(sealSecret("account-number", PLAINTEXT).keyVersion, 1);
  });

  it("produces a different initialisation vector every time", () => {
    const first = sealSecret("account-number", PLAINTEXT);
    const second = sealSecret("account-number", PLAINTEXT);

    assert.ok(
      !first.initialisationVector.equals(second.initialisationVector),
      "a reused initialisation vector breaks AES-GCM completely",
    );
  });

  it("produces different ciphertext for the same plaintext every time", () => {
    const first = sealSecret("account-number", PLAINTEXT);
    const second = sealSecret("account-number", PLAINTEXT);

    assert.ok(!first.ciphertext.equals(second.ciphertext));
  });

  it("does not leave the plaintext readable in the ciphertext", () => {
    const sealed = sealSecret("account-number", PLAINTEXT);

    assert.ok(!sealed.ciphertext.toString("utf8").includes(PLAINTEXT));
  });
});

describe("openSecret", () => {
  it("returns the original value", () => {
    const sealed = sealSecret("account-number", PLAINTEXT);

    assert.equal(openSecret("account-number", sealed), PLAINTEXT);
  });

  it("round trips every purpose", () => {
    for (const purpose of [
      "account-number",
      "totp-secret",
      "monero-view-key",
    ] as const) {
      assert.equal(openSecret(purpose, sealSecret(purpose, PLAINTEXT)), PLAINTEXT);
    }
  });

  it("rejects a ciphertext opened under a different purpose", () => {
    const sealed = sealSecret("account-number", PLAINTEXT);

    assert.throws(() => openSecret("totp-secret", sealed));
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = sealSecret("account-number", PLAINTEXT);
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;

    assert.throws(() => openSecret("account-number", tampered));
  });

  it("rejects a tampered authentication tag", () => {
    const sealed = sealSecret("account-number", PLAINTEXT);
    const tampered = {
      ...sealed,
      authenticationTag: Buffer.from(sealed.authenticationTag),
    };
    tampered.authenticationTag[0] ^= 0xff;

    assert.throws(() => openSecret("account-number", tampered));
  });

  it("rejects a tampered initialisation vector", () => {
    const sealed = sealSecret("account-number", PLAINTEXT);
    const tampered = {
      ...sealed,
      initialisationVector: Buffer.from(sealed.initialisationVector),
    };
    tampered.initialisationVector[0] ^= 0xff;

    assert.throws(() => openSecret("account-number", tampered));
  });

  it("rejects an unknown key version instead of falling back", () => {
    const sealed = sealSecret("account-number", PLAINTEXT);

    assert.throws(() => openSecret("account-number", { ...sealed, keyVersion: 99 }));
  });
});
