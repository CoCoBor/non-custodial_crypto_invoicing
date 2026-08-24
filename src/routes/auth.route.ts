import { Router } from "express";
import { getDatabase } from "../infrastructure/database/mongodb.js";
import { createAccount } from "../accounts/account.repository.js";
import { formatAccountNumberForDisplay } from "../security/secret-generator.js";

export const authRouter = Router();

authRouter.post("/register", async (_req, res) => {
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
