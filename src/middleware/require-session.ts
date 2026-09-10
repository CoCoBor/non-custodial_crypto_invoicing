import { NextFunction, Request, RequestHandler, Response } from "express";
import { getDatabase } from "../infrastructure/database/mongodb.js";
import * as Session from "../sessions/session.repository.js";
import { SessionDocument } from "../sessions/session.model.js";
import { findUserById } from "../accounts/user.repository.js";

async function resolveSession(
  req: Request,
  res: Response,
): Promise<SessionDocument | undefined> {
  const token = req.cookies?.session;

  if (!token) {
    res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
    return undefined;
  }

  const database = getDatabase();
  const session = await Session.findValidSession(database, token);

  if (!session) {
    res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
    return undefined;
  }

  return session;
}

function requireStatus(status: "active" | "pending_totp"): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await resolveSession(req, res);

    if (!session) {
      return;
    }

    const { _id, accountId } = session;

    if (session.status !== status) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "authentication required" },
      });
    }

    const user = await findUserById(session.accountId);

    if (!user) {
      return res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "authentication required",
        },
      });
    }

    const database = getDatabase();
    const expiresAt = await Session.touchSession(database, _id);

    req.session = {
      sessionId: _id,
      accountId: accountId,
      expiresAt,
    };

    next();
  };
}

export const requireSession = requireStatus("active");
export const requirePendingTotpSession = requireStatus("pending_totp");
