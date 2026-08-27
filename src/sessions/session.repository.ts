import { Db, ObjectId } from "mongodb";
import {
  SessionDocument,
  SESSIONS_COLLECTION,
  SessionStatus,
} from "./session.model.js";
import {
  generateSessionToken,
  hashBearerToken,
} from "../security/secret-generator.js";

export interface CreateSessionInput {
  accountId: ObjectId;
  status: SessionStatus;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreatedSession {
  sessionId: ObjectId;
  token: string;
}

export async function createSession(
  database: Db,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const { accountId, status, ipAddress, userAgent } = input;
  const collection = database.collection<SessionDocument>(SESSIONS_COLLECTION);
  const sessionId = new ObjectId();
  const token = generateSessionToken();
  const date = new Date();
  const lastSeenDate = date;
  const expiredDate = new Date(lastSeenDate.getTime() + 30 * 60 * 1000);
  const absoluteExpiredDate = new Date(date.getTime() + 12 * 60 * 60 * 1000);

  const document: SessionDocument = {
    _id: sessionId,
    tokenHash: hashBearerToken(token),
    accountId: accountId,
    status: status,
    createdAt: date,
    lastSeenAt: lastSeenDate,
    expiresAt: expiredDate,
    absoluteExpiresAt: absoluteExpiredDate,
    ipAddress: ipAddress,
    userAgent: userAgent,
  };

  await collection.insertOne(document);

  return {
    sessionId,
    token,
  };
}

export async function findValidSession(
  database: Db,
  token: string,
): Promise<SessionDocument | null> {
  const collection = database.collection<SessionDocument>(SESSIONS_COLLECTION);
  const tokenHash = hashBearerToken(token);
  const now = new Date();

  try {
    const session = await collection.findOne({
      tokenHash: tokenHash,
      expiresAt: { $gt: now },
      absoluteExpiresAt: { $gt: now },
    });
    if (!session) {
      return null;
    }
    return session;
  } catch (error) {
    throw error;
  }
}

export async function touchSession(
  database: Db,
  sessionId: ObjectId,
): Promise<Date> {
  const collection = database.collection<SessionDocument>(SESSIONS_COLLECTION);

  const date = new Date();

  const newExpiresAt = new Date(date.getTime() + 30 * 60 * 1000);

  await collection.updateOne(
    { _id: sessionId },
    { $set: { expiresAt: newExpiresAt, lastSeenAt: date } },
  );

  return newExpiresAt;
}

export async function deleteSession(
  database: Db,
  token: string,
): Promise<void> {
  const collection = database.collection<SessionDocument>(SESSIONS_COLLECTION);
  const tokenHash = hashBearerToken(token)
  await collection.deleteOne({ tokenHash });

  return
}
