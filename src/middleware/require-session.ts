import { NextFunction, Request, RequestHandler, Response } from "express";
import { getDatabase } from "../infrastructure/database/mongodb.js";
import {
  findValidSession,
  touchSession,
} from "../sessions/session.repository.js";

export const requireSession: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const token = req.cookies?.session;

  if (!token) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  const db = getDatabase();
  const session = await findValidSession(db, token);

  if (!session) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  const { status, _id, accountId } = session;

  if (status !== "active") {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  const newExpiresAt = await touchSession(db, _id);

  req.session = {
    sessionId: _id,
    accountId: accountId,
    expiresAt: newExpiresAt,
  };

  next();
};
