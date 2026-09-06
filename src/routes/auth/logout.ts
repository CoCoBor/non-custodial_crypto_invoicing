import { Router } from "express";

import { env } from "../../config/env.js";
import { getDatabase } from "../../infrastructure/database/mongodb.js";
import { deleteSession } from "../../sessions/session.repository.js";

export const logoutRouter = Router();

logoutRouter.post("/", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const token = req.cookies?.session;

  if (token) {
    const db = getDatabase();
    await deleteSession(db, token);
  }

  res.clearCookie("session", {
    httpOnly: true,
    secure: env.nodeEnvironment === "production",
    sameSite: "strict",
    path: "/",
  });

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    data: {
      loggedOut: true,
    },
  });
});
