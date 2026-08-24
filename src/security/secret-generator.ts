import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

export function generateAccountNumber(): string {
  let num: string = "";
  for (let i = 0; i < 16; i++) {
    num += randomInt(0, 10);
  }
  return num;
}

export function normaliseAccountNumber(input: string): string | undefined {
    const cleaned: string = input.replaceAll("-", "").replaceAll(" ", "")
    if(!cleaned.match(/^[0-9]{16}$/)){
        return undefined
    }
    return cleaned
}

export function formatAccountNumberForDisplay(accountNumber: string): string {
    const matches = accountNumber.match(/.{1,4}/g)
    const result: string = matches ? matches.join('-') : ""

    return result
}

export function generateApiKey(): string {
    return randomUUID()
}

export function generateSessionToken(): string {
    return randomBytes(32).toString("base64url")
}

export function hashBearerToken(token: string): string {
    return createHash("sha256").update(token, "utf-8").digest("base64url")
}
