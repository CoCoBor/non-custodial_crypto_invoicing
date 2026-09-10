import { Router } from "express";

import { createMerchantAccount } from "../../accounts/user.repository.js";
import { formatAccountNumberForDisplay } from "../../security/secret-generator.js";

export const registerRouter = Router();

registerRouter.post("/", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const { accountNumber, userId, recoveryPhrase } =
    await createMerchantAccount();
  res.status(201).json({
    data: {
      userId,
      accountNumber,
      accountNumberDisplay: formatAccountNumberForDisplay(accountNumber),
      recoveryPhrase,
    },
  });
});
