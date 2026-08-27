import { ObjectId } from "mongodb";

export const SESSIONS_COLLECTION = "sessions";
export type SessionStatus = "pending_totp" | "active";
export interface SessionDocument {
  _id: ObjectId;
  tokenHash: string; // SHA-256(token)，unique index
  accountId: ObjectId; // index，use to kill all the session of the account
  status: "pending_totp" | "active";
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date; // TTL index
  absoluteExpiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}
