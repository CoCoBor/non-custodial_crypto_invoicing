import { Router } from "express";
import { z } from "zod";

import { setBitcoinAccountKey } from "../../accounts/account.repository.js";
import {
  deriveReceiveAddress,
  parseExtendedPublicKey,
} from "../../chains/bitcoin/extended-key.js";
import { getDatabase } from "../../infrastructure/database/mongodb.js";
import { requireSession } from "../../middleware/require-session.js";

export const bitcoinSettlementRouter = Router();

const extendedPublicKeySchema = z.object({
  extendedPublicKey: z.string(),
});

bitcoinSettlementRouter.put("/", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parseResult = extendedPublicKeySchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  const bitcoinAccountKey = parseExtendedPublicKey(
    parseResult.data.extendedPublicKey,
  );

  if (bitcoinAccountKey === undefined) {
    return res.status(400).json({
      error: {
        code: "INVALID_EXTENDED_KEY",
        message: "extended public key is invalid",
      },
    });
  }

  const db = getDatabase();
  const accountId = req.session!.accountId;
  await setBitcoinAccountKey(db, accountId, bitcoinAccountKey);
  const firstAddress = deriveReceiveAddress(bitcoinAccountKey, 0);

  res.status(200).json({
    data: {
      scriptType: bitcoinAccountKey.scriptType,
      firstAddress,
    },
  });
});
