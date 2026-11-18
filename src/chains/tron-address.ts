import { decodeBase58, encodeBase58, getAddress, sha256, toBeArray } from "ethers";

// Tron addresses: 0x41 followed by the same 20 bytes an EVM address has
// (keccak256 of the secp256k1 public key), shown as base58check ("T…").
// No env import: src/config/env.ts uses this file.

const MAINNET_PREFIX = 0x41;
const ADDRESS_BYTES = 21;

function checksum(payload: Uint8Array): Buffer {
  return Buffer.from(sha256(sha256(payload)).slice(2), "hex").subarray(0, 4);
}

/** The 21 address bytes (0x41 + 20) of a base58check Tron address, or undefined. */
export function tronAddressBytes(address: string): Buffer | undefined {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return undefined;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(toBeArray(decodeBase58(address)));
  } catch {
    return undefined;
  }
  if (decoded.length !== ADDRESS_BYTES + 4) return undefined;
  const payload = decoded.subarray(0, ADDRESS_BYTES);
  if (payload[0] !== MAINNET_PREFIX) return undefined;
  if (!checksum(payload).equals(decoded.subarray(ADDRESS_BYTES))) return undefined;
  return Buffer.from(payload);
}

// The all-zero address passes the format check, but nobody can spend from it.
export function isValidTronAddress(address: string): boolean {
  const bytes = tronAddressBytes(address);
  return bytes !== undefined && bytes.subarray(1).some((byte) => byte !== 0);
}

/** base58check text of 21 address bytes (0x41 + 20). */
export function tronAddressFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== ADDRESS_BYTES || bytes[0] !== MAINNET_PREFIX) throw new Error("not a 21-byte Tron address");
  return encodeBase58(Buffer.concat([bytes, checksum(bytes)]));
}

/** The Tron address of an EVM-style 0x… address (same key, same 20 bytes). */
export function tronAddressFromEvm(evmAddress: string): string {
  return tronAddressFromBytes(Buffer.concat([Buffer.from([MAINNET_PREFIX]), Buffer.from(getAddress(evmAddress).slice(2), "hex")]));
}

/** The 0x… form of a Tron address's 20 bytes, as contract ABI and logs use it. */
export function evmFormOfTronAddress(address: string): string | undefined {
  const bytes = tronAddressBytes(address);
  return bytes === undefined ? undefined : getAddress("0x" + bytes.subarray(1).toString("hex"));
}
