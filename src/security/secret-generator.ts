import { createHash, randomBytes, randomUUID } from "node:crypto";

export function generateApiKey(): string {
    return randomUUID()
}

export function generateSessionToken(): string {
    return randomBytes(32).toString("base64url")
}

export function hashBearerToken(token: string): string {
    return createHash("sha256").update(token, "utf-8").digest("base64url")
}
