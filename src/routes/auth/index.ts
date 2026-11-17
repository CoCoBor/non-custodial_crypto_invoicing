import { Router } from "express";

import { loginRouter } from "./login.js";
import { logoutRouter } from "./logout.js";
import { registerRouter } from "./register.js";
import { sessionRouter } from "./session.js";
import { twoFactorRouter } from "./2fa.js";
import { apiKeyRouter } from "./api-key.js";
import { challengeRouter } from "./challenge.js";
import { recoveryRouter } from "./recovery.js";

export const authRouter = Router();

authRouter.use("/register", registerRouter);
authRouter.use("/create", registerRouter);
authRouter.use("/login", loginRouter);
authRouter.use("/logout", logoutRouter);
authRouter.use("/session", sessionRouter);
authRouter.use("/2fa", twoFactorRouter);
authRouter.use("/api-key", apiKeyRouter);
authRouter.use("/challenge", challengeRouter);
authRouter.use("/recovery", recoveryRouter);
