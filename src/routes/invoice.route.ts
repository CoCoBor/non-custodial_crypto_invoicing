import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/require-session.js";
import { getDatabase } from "../infrastructure/database/mongodb.js";
import { findAccountById } from "../accounts/account.repository.js";
import {
  createInvoice,
  CreateInvoiceInput,
} from "../invoices/invoice.repository.js";

export const invoiceRouter = Router();

const invoiceSchema = z.object({
  amountSatoshi: z.number(),
  lifetimeMinutes: z.number().optional(),
  underpaidTolerancePercent: z.number().optional(),
});

const DUST_LIMIT_SATOSHI = 546;
const DEFAULT_LIFETIME_MINUTES = 30;
const DEFAULT_UNDERPAID_TOLERANCE_PERCENT = 0;
const SATOSHIS_PER_COIN = 100_000_000
const MAX_MONEY = 21_000_000 * SATOSHIS_PER_COIN

function satoshiToBtcString(amountSatoshi: number): string {
  const padded = String(amountSatoshi).padStart(9, "0");
  const wholePart = padded.slice(0, -8);
  const fractionalPart = padded.slice(-8).replace(/0+$/, ""); // "50000000" ->"5"
  return fractionalPart.length > 0
    ? `${wholePart}.${fractionalPart}`
    : wholePart;
}

invoiceRouter.post("/", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parseResult = invoiceSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });
  }

  const { amountSatoshi } = parseResult.data;

  const lifetimeMinutes =
    parseResult.data.lifetimeMinutes ?? DEFAULT_LIFETIME_MINUTES;

  const underpaidTolerancePercent =
    parseResult.data.underpaidTolerancePercent ??
    DEFAULT_UNDERPAID_TOLERANCE_PERCENT;

  if (!Number.isInteger(amountSatoshi) || amountSatoshi < DUST_LIMIT_SATOSHI || amountSatoshi> MAX_MONEY) {
    return res.status(400).json({
      error: {
        code: "INVALID_AMOUNT",
        message: "amount is below the minimum payable amount",
      },
    });
  }

  if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1 || lifetimeMinutes > 60) {
    return res.status(400).json({
      error: {
        code: "INVALID_LIFETIME",
        message: "lifetime must be between 1 and 60 minutes",
      },
    });
  }

  if (
    !Number.isInteger(underpaidTolerancePercent) ||
    underpaidTolerancePercent < 0 ||
    underpaidTolerancePercent > 100
  ) {
    return res.status(400).json({
      error: {
        code: "INVALID_TOLERANCE",
        message: "tolerance must be between 0 and 100",
      },
    });
  }

  const accountId = req.session!.accountId;
  const db = getDatabase();
  const account = await findAccountById(db, accountId);

  if (!account) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  const { bitcoinAccountKey } = account;

  if (!bitcoinAccountKey) {
    return res.status(409).json({
      error: {
        code: "SETTLEMENT_NOT_CONFIGURED",
        message: "no settlement key is configured for this account",
      },
    });
  }

  const input: CreateInvoiceInput = {
    accountId,
    accountKey: bitcoinAccountKey,
    amountSatoshi,
    lifetimeMinutes,
    underpaidTolerancePercent,
  };

  const invoice = await createInvoice(db, input);

  if (!invoice) {
    return res.status(409).json({
      error: {
        code: "SETTLEMENT_NOT_CONFIGURED",
        message: "no settlement key is configured for this account",
      },
    });
  }

  const { publicId, status, address, expiresAt } = invoice;

  res.status(201).json({
    data: {
      invoiceId: publicId,
      status,
      amountSatoshi: invoice.amountSatoshi,
      address,
      paymentUri: `bitcoin:${address}?amount=${satoshiToBtcString(invoice.amountSatoshi)}`,
      expiresAt,
      underpaidTolerancePercent: invoice.underpaidTolerancePercent
    },
  });
});
