import { Router } from "express";

import * as userRepo from "../../auth/user.repository.js";
import * as userFunc from "../../auth/user.function.js";

export const registerRouter = Router();

registerRouter.post("/", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const { accountNumber, userId, recoveryPhrase } =
    await userRepo.createMerchantAccount();
  res.status(201).json({
    data: {
      userId,
      accountNumber,
      accountNumberDisplay: userFunc.formatAccountNumberForDisplay(accountNumber),
      recoveryPhrase,
    },
  });
});