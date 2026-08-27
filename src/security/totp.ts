import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "sha1";
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const SECRET_BYTES = 20;

const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Precomputed map for fast O(1) character lookup
const CHAR_MAP: Record<string, number> = {};
for (let i = 0; i < RFC4648_ALPHABET.length; i++) {
  CHAR_MAP[RFC4648_ALPHABET[i]] = i;
}

export function base32Encode(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += RFC4648_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += RFC4648_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decodes a Base32 string into a Buffer.
 * @param input - The Base32 encoded string (case-insensitive, padding optional)
 */
export function base32Decode(input: string): Buffer {
  const cleanInput = input.toUpperCase().replace(/=+$/, '');

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleanInput.length; i++) {
    const char = cleanInput[i];
    const val = CHAR_MAP[char];

    if (val === undefined) {
      throw new Error(`Invalid Base32 character "${char}" at position ${i}`);
    }

    value = (value << 5) | val;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function generateTotpCode(secret: string, atTime?:Date):string{
    const ke
}

export function verifyTotpCode(secret:string,code:string,atTime?:Date): number|undefined{

}

export function buildTotpUri(issuer: string, accountLabel: string,secret:string):string{

}
