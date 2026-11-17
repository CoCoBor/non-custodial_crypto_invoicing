import {
  Schema,
  model,
  type InferSchemaType,
  type HydratedDocument,
} from "mongoose";

export const SESSIONS_COLLECTION = "sessions";

// totp_setup: first login done with the 12 words; may only set up TOTP.
export const SESSION_STATUSES = ["totp_setup", "pending_totp", "active"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const sessionSchema = new Schema(
  {
    sessionId: { type: String, required: true },
    // SHA-256(token). The token itself is never stored.
    tokenHash: { type: String, required: true },
    // The merchant's public uuid; the key every session of one merchant
    // shares, so they can all be revoked together.
    userId: { type: String, required: true },
    status: { type: String, enum: SESSION_STATUSES, required: true },
    createdAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    // Sliding expiry, extended on every request; the TTL index reaps on it.
    expiresAt: { type: Date, required: true },
    // Hard ceiling that sliding never moves past.
    absoluteExpiresAt: { type: Date, required: true },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { collection: SESSIONS_COLLECTION, autoCreate: false, autoIndex: false },
);
sessionSchema.index({ sessionId: 1 }, { unique: true });
sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1 });

export type SessionData = InferSchemaType<typeof sessionSchema>;
export type SessionDocument = HydratedDocument<SessionData>;
export const Session = model("Session", sessionSchema);
