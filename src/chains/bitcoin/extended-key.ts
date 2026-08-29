import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createBase58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { p2pkh, p2sh, p2wpkh } from "@scure/btc-signer";

export type BitcoinScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh";

export interface BitcoinAccountKey {
  key: string;
  scriptType: BitcoinScriptType;
}

const b58c = createBase58check(sha256);

const VERSION_BYTES = {
  xpub: "0488b21e", //bip-44
  ypub: "049d7cb2", //bit-49
  zpub: "04b24746", //bip-84
};

const SCRIPT_TYPE_BY_VERSION: Record<string, BitcoinScriptType> = {
  [VERSION_BYTES.xpub]: "p2pkh",
  [VERSION_BYTES.ypub]: "p2sh-p2wpkh",
  [VERSION_BYTES.zpub]: "p2wpkh",
};

const XPUB_VERSION_BYTES = hexToBytes(VERSION_BYTES.xpub);


export function parseExtendedPublicKey(
  input: string,
): BitcoinAccountKey | undefined {
  try {
    const trimmed = input.trim();
    const decoded = b58c.decode(trimmed);

    const versionHex = bytesToHex(decoded.slice(0, 4))
    const scriptType = SCRIPT_TYPE_BY_VERSION[versionHex];

    if (!scriptType) {
      return undefined;
    }

    // b58c common use Btc
    const normalisedBytes = Uint8Array.from(decoded);
    // bcs lib @scure/bip32 only know xpub format so put it first
    normalisedBytes.set(XPUB_VERSION_BYTES, 0);
    const normalisedKey = b58c.encode(normalisedBytes);

    const hdKey = HDKey.fromExtendedKey(normalisedKey);

    if (hdKey.privateKey !== null) {
      return undefined;
    }

    return { key: normalisedKey, scriptType };
  } catch {
    return undefined;
  }
}

// (Hierarchical Deterministic) HD wallet derivation
export function deriveReceiveAddress(
  account: BitcoinAccountKey,
  index: number,
): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= 2_147_483_648) {
    return undefined;
  }
  try {
    const hdKey = HDKey.fromExtendedKey(account.key);
    const child = hdKey.deriveChild(0).deriveChild(index);

    if (!child.publicKey) {
      return undefined;
    }
    switch (account.scriptType) {
      case "p2pkh":
        return p2pkh(child.publicKey).address;
      case "p2sh-p2wpkh":
        return p2sh(p2wpkh(child.publicKey)).address;
      case "p2wpkh":
        return p2wpkh(child.publicKey).address;
    }
  } catch (error) {
    return undefined;
  }
}
