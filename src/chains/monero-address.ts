import { keccak256 } from "ethers";

// Monero addresses: network byte + public spend key (32) + public view key
// (32) [+ payment id (8) for integrated] + checksum (4), in Monero's own
// base58. No env import: src/config/env.ts uses this file.
//
// Monero's base58 is not Bitcoin's: the bytes are cut into 8-byte blocks and
// each block is encoded on its own into 11 characters (a shorter last block
// into fewer), so leading zero bytes are not special.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const FULL_BLOCK_BYTES = 8;
const FULL_BLOCK_CHARS = 11;
/** Characters an encoded block of n bytes takes, n = 0..8. */
const ENCODED_BLOCK_CHARS = [0, 2, 3, 5, 6, 7, 9, 10, 11];

export type MoneroAddressKind = "standard" | "subaddress" | "integrated";

// Mainnet only (src/cryptonote_config.h, CRYPTONOTE_PUBLIC_*_BASE58_PREFIX).
// Each fits in one varint byte. Testnet uses 53/54/63, stagenet 24/25/36.
const MAINNET_PREFIXES: Record<number, { kind: MoneroAddressKind; bytes: number }> = {
  18: { kind: "standard", bytes: 69 },
  42: { kind: "subaddress", bytes: 69 },
  19: { kind: "integrated", bytes: 77 },
};

function decodeBlock(block: string): number[] | undefined {
  const size = ENCODED_BLOCK_CHARS.indexOf(block.length);
  if (size <= 0) return undefined;
  let value = 0n;
  for (const char of block) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    value = value * 58n + BigInt(digit);
  }
  if (value >= 1n << BigInt(8 * size)) return undefined;
  const bytes: number[] = [];
  for (let i = size - 1; i >= 0; i--) bytes.push(Number((value >> BigInt(8 * i)) & 0xffn));
  return bytes;
}

/** Monero base58 to bytes, or undefined when it is not valid Monero base58. */
export function decodeMoneroBase58(text: string): Uint8Array | undefined {
  const bytes: number[] = [];
  for (let start = 0; start < text.length; start += FULL_BLOCK_CHARS) {
    const block = decodeBlock(text.slice(start, start + FULL_BLOCK_CHARS));
    if (block === undefined) return undefined;
    if (start + FULL_BLOCK_CHARS < text.length && block.length !== FULL_BLOCK_BYTES) return undefined;
    bytes.push(...block);
  }
  return bytes.length === 0 ? undefined : Uint8Array.from(bytes);
}

/** What a mainnet Monero address is, or undefined when it is not one (bad checksum, other network, other chain). */
export function moneroAddressKind(address: string): MoneroAddressKind | undefined {
  if (address.length !== 95 && address.length !== 106) return undefined;
  const bytes = decodeMoneroBase58(address);
  if (bytes === undefined) return undefined;
  const format = MAINNET_PREFIXES[bytes[0]!];
  if (format === undefined || bytes.length !== format.bytes) return undefined;
  const body = bytes.subarray(0, bytes.length - 4);
  const expected = Buffer.from(keccak256(body).slice(2, 10), "hex");
  if (!expected.equals(Buffer.from(bytes.subarray(bytes.length - 4)))) return undefined;
  return format.kind;
}

// An integrated address can't be paid next to a second destination
// (monero-wallet-rpc v0.18.5.4 answers "transaction was not constructed"),
// and every payout above a 0% fee has a platform output. So only standard
// addresses and subaddresses can receive payouts.
export function isValidMoneroAddress(address: string): boolean {
  const kind = moneroAddressKind(address);
  return kind === "standard" || kind === "subaddress";
}
