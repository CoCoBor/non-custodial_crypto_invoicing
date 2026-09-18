import { Router } from "express";
import * as sessionRepo from "../../sessions/session.repository.js";
import { env } from "../../config/env.js";

export const logoutRouter = Router();


logoutRouter.post("/", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const token = req.cookies?.session

  if(token) await sessionRepo.deleteSession(token)

  res.clearCookie("session", {
    httpOnly: true,
    secure: env.nodeEnvironment === "production",
    sameSite: "strict",
    path: "/",
  })

  res.status(200).json({
    data:{
      loggedOut: true
    }
  })
});
