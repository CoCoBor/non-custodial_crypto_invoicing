import {
  generateSessionToken,
  hashBearerToken,
} from "../security/secret-generator.js";
import {
  Session,
  SessionDocument,
  SessionStatus,
} from "../database/session.model.js";
import { randomUUID } from "node:crypto";

export interface CreatedSession {
  sessionId: string;
  token: string;
}

export async function createSession(
  input: {
  userId: string;
  status: SessionStatus;
  ipAddress: string | null;
  userAgent: string | null;
},
): Promise<{
  sessionId: string;
  token: string;
}> {
  const { userId, status, ipAddress, userAgent } = input;
  const sessionId = randomUUID();
  const token = generateSessionToken();
  const date = new Date();
  const lastSeenDate = date;
  const expiredDate = new Date(lastSeenDate.getTime() + 30 * 60 * 1000);
  const absoluteExpiredDate = new Date(date.getTime() + 12 * 60 * 60 * 1000);

  const document = {
    sessionId,
    tokenHash: hashBearerToken(token),
    userId,
    status: status,
    createdAt: date,
    lastSeenAt: lastSeenDate,
    expiresAt: expiredDate,
    absoluteExpiresAt: absoluteExpiredDate,
    ipAddress: ipAddress,
    userAgent: userAgent,
  };

  await Session.insertOne(document);

  return {
    sessionId,
    token,
  };
}

export async function findValidSession(
  token: string,
): Promise<SessionDocument | null> {
  const tokenHash = hashBearerToken(token);
  const now = new Date();

  try {
    const session = await Session.findOne({
      tokenHash: tokenHash,
      expiresAt: { $gt: now },
      absoluteExpiresAt: { $gt: now },
    });
    if (!session) return null;

    return session;
  } catch (error) {
    throw error;
  }
}

export async function touchSession(sessionId: string): Promise<Date> {
  const date = new Date();

  const newExpiresAt = new Date(date.getTime() + 30 * 60 * 1000);

  await Session.updateOne(
    { sessionId },
    { $set: { expiresAt: newExpiresAt, lastSeenAt: date } },
  );

  return newExpiresAt;
}

export async function deleteSession(token: string): Promise<void> {
  const tokenHash = hashBearerToken(token);
  await Session.deleteOne({ tokenHash });

  return;
}
