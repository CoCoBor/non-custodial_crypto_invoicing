import { randomBytes, createHmac } from "node:crypto";

const ALGORITHM = "SHA1"
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const WINDOW = 1;

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  while (output.length % 8 !== 0) {
    output += "=";
  }

  return output;
}

function base32Decode(input: string): Buffer | undefined {
  const cleaned = input.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      return undefined;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function counterToBuffer(counter: number): Buffer {
  const buffer = Buffer.alloc(8);
  let remaining = BigInt(Math.floor(counter));
  // let remaining = 58539840n = 0x037D3F40
  for (let i = 7; i >= 0; i--) {
    buffer[i] = Number(remaining & 0xffn);
    remaining >>= 8n;

    // 	i=7	0x037D3F40	0x40 = 64	buffer[7] = 64	0x00037D3F = 228671
    // 	i=6	0x00037D3F	0x3F = 63	buffer[6] = 63	0x0000037D = 893
    // 	i=5	0x0000037D	0x7D = 125	buffer[5] = 125	0x00000003 = 3
    // 	i=4	0x00000003	0x03 = 3	buffer[4] = 3	0x00000000 = 0
    // 	i=3	0x00000000	0x00 = 0	buffer[3] = 0	still 0
    // 	i=2	0	0	buffer[2] = 0	0
    // 	i=1	0	0	buffer[1] = 0	0
    // 	i=0	0	0	buffer[0] = 0	0
  }
  return buffer;
}

function hotp(keyBuffer: Buffer, counter: number): string {
  const counterBuffer = counterToBuffer(counter);
  // "sha1" only output 20bytes buffer
  const hmac = createHmac(ALGORITHM, keyBuffer).update(counterBuffer).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  // sample last byte of buffer is 1001_0110 & 0000_1111(0x0f) = 0000_0110 = 6
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    10 ** DIGITS;

  //  0x4c & 0x7f) << 24  =  0x4c000000  =  1,275,068,416
  // (0x93 & 0xff) << 16  =  0x00930000  =      9,633,792
  // (0x8b & 0xff) << 8   =  0x00008b00  =         35,584
  // (0x2e & 0xff)        =  0x0000002e  =             46
  //                                         ─────────────
  //                      =  0x4c938b2e  =  1,284,737,838

  return String(code).padStart(DIGITS, "0");
}

function currentStep(atTime: Date): number {
  return Math.floor(atTime.getTime() / 1000 / PERIOD_SECONDS);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function generateTotpCode(
  secret: string,
  atTime: Date = new Date(),
): string {
  const keyBuffer = base32Decode(secret);
  if (!keyBuffer) {
    throw new Error("invalid base32 secret");
  }
  return hotp(keyBuffer, currentStep(atTime));
}

export function verifyTotpCode(
  secret: string,
  code: string,
  atTime: Date = new Date(),
): number | undefined {
  const keyBuffer = base32Decode(secret);
  if (!keyBuffer) {
    return undefined;
  }

  const step = currentStep(atTime);

  for (let window = -WINDOW; window <= WINDOW; window++) {
    const candidateStep = step + window;
    if (hotp(keyBuffer, candidateStep) === code) {
      return candidateStep;
    }
  }

  return undefined;
}

export function buildTotpUri(
  issuer: string,
  accountLabel: string,
  secret: string,
): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: ALGORITHM,
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}