import type { Response } from "express";

import type { CancelResult } from "../invoice/cancel.js";

/** The same answers for the merchant's cancel and the payer's. */
export function answerCancel(res: Response, invoiceId: string, result: CancelResult) {
  switch (result) {
    case "cancelled":
      return res.status(200).json({ data: { invoiceId, status: "cancelled" } });
    case "payment_seen":
      return res.status(409).json({
        error: { code: "CANNOT_CANCEL", message: "a payment has already been seen for this invoice" },
      });
    case "chain_unavailable":
      return res.status(503).json({
        error: { code: "CHAIN_UNAVAILABLE", message: "could not check the chain for payments; try again" },
      });
  }
}
