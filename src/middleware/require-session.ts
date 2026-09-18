import { NextFunction, Request, RequestHandler, Response } from "express";
import * as sessionRepo from "../sessions/session.repository.js";
import { SessionDocument } from "../database/session.model.js";
import { findUserByUserId } from "../auth/user.function.js";

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

  const session = await sessionRepo.findValidSession(token);

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

    const { sessionId, userId } = session;

    if (session.status !== status) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "authentication required" },
      });
    }

    const user = await findUserByUserId(userId);

    if (!user) {
      return res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "authentication required",
        },
      });
    }

    const expiresAt = await sessionRepo.touchSession(sessionId);

    req.session = {
      sessionId,
      userId,
      expiresAt,
    };

    next();
  };
}

export const requireSession = requireStatus("active");
export const requirePendingTotpSession = requireStatus("pending_totp");
