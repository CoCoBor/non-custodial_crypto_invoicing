import { Router } from "express";
import { z } from "zod";

import type { AppDeps } from "../../app.js";
import { Invoice } from "../../database/invoices.model.js";
import { cancelIfUnpaid } from "../../invoice/cancel.js";
import { requireSession } from "../../middleware/require-session.js";
import { answerCancel } from "../cancel-response.js";

// The merchant's dashboard actions on their own invoices. Session only: the
// API key can create invoices and read them, nothing else.

const invoiceIdSchema = z.uuid();

export function createDashboardRouter(deps: AppDeps) {
  const router = Router();

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(requireSession);

  router.post("/invoices/:invoiceId/cancel", async (req, res) => {
    const invoiceId = req.params.invoiceId;
    const invoice = invoiceIdSchema.safeParse(invoiceId).success
      ? await Invoice.findOne({ invoice_id: invoiceId, user_id: req.session!.userId })
          .select("invoice_id status paid_amount crypto address -_id")
          .lean()
          .exec()
      : null;
    // Another merchant's invoice looks the same as one that does not exist.
    if (!invoice) {
      return res.status(404).json({
        error: { code: "INVOICE_NOT_FOUND", message: "invoice was not found" },
      });
    }
    return answerCancel(res, invoice.invoice_id, await cancelIfUnpaid(invoice, deps.chains, Date.now()));
  });

  return router;
}
