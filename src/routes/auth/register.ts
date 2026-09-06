import { Router } from "express";

import { createAccount } from "../../accounts/account.repository.js";
import { getDatabase } from "../../infrastructure/database/mongodb.js";
import { formatAccountNumberForDisplay } from "../../security/secret-generator.js";

export const registerRouter = Router();

registerRouter.post("/", async (_req, res) => {
  const db = getDatabase();
  const { accountNumber, mnemonic } = await createAccount(db);

  res.set("Cache-Control", "no-store");
  res.status(201).json({
    data: {
      accountNumber,
      accountNumberDisplay: formatAccountNumberForDisplay(accountNumber),
      recoveryPhrase: mnemonic,
    },
  });
});
