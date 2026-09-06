import { createBase58check } from "@scure/base";
import {  addressFromPublicKey, BitcoinScriptType } from "./extended-key.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";

export interface PlatformAccountKey {
  key: string;
  scriptType: BitcoinScriptType;
}

export interface DepositKey{
    address: string
    privateKey: Uint8Array

}
const b58c = createBase58check(sha256);

const PRIVATE_VERSION_BYTES = {
  xprv: "0488ade4",
  yprv: "049d7878",
  zprv: "04b2430c",
};

const SCRIPT_TYPE_BY_PRIVATE_VERSION: Record<string, BitcoinScriptType> = {
  [PRIVATE_VERSION_BYTES.xprv]: "p2pkh",
  [PRIVATE_VERSION_BYTES.yprv]: "p2sh-p2wpkh",
  [PRIVATE_VERSION_BYTES.zprv]: "p2wpkh",
};

const XPRV_VERSION_BYTES = hexToBytes(PRIVATE_VERSION_BYTES.xprv);


export function parseExtendedPrivateKey(
  input: string,
): PlatformAccountKey | undefined {
  try {
    const trimmed = input.trim();
    const decoded = b58c.decode(trimmed);

    const versionHex = bytesToHex(decoded.slice(0, 4))
    const scriptType = SCRIPT_TYPE_BY_PRIVATE_VERSION[versionHex];

    if (!scriptType) {
      return undefined;
    }

    // b58c common use Btc
    const normalisedBytes = Uint8Array.from(decoded);
    // bcs lib @scure/bip32 only know xprv format so put it first
    normalisedBytes.set(XPRV_VERSION_BYTES, 0);
    const normalisedKey = b58c.encode(normalisedBytes);

    const hdKey = HDKey.fromExtendedKey(normalisedKey);

    if (hdKey.privateKey === null) {
      return undefined;
    }

    return { key: normalisedKey, scriptType };
  } catch {
    return undefined;
  }
}

export function deriveDepositKey(
  account: PlatformAccountKey,
  index: number,
): DepositKey | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= 2_147_483_648) {
    return undefined;
  }
  try {
    const hdKey = HDKey.fromExtendedKey(account.key);
    const child = hdKey.deriveChild(0).deriveChild(index);

    if (!child.publicKey|| !child.privateKey) {
      return undefined;
    }

    const address  = addressFromPublicKey(child.publicKey, account.scriptType)

    if(address=== undefined){
        return undefined
    }

    return {address, privateKey: child.privateKey}

  } catch (error) {
    return undefined;
  }
}