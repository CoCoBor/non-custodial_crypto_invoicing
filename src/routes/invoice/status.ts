import { Router } from "express";

import { getDatabase } from "../../infrastructure/database/mongodb.js";
import { buildPaymentUri } from "./payment-uri.js";
import { findInvoiceByPublicId } from "../../invoices/invoice.repository.js";

export const invoiceStatusRouter = Router();

invoiceStatusRouter.get("/:invoiceId", async (req, res) => {
  const database = getDatabase();
  const invoice = await findInvoiceByPublicId(database, req.params.invoiceId);

  if (!invoice) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "invoice not found" },
    });
  }

  res.set("Cache-Control", "no-store");
  return res.status(200).json({
    data: {
      invoiceId: invoice.publicId,
      status: invoice.status,
      amountSatoshi: invoice.amountSatoshi,
      paidSatoshi: invoice.paidSatoshi,
      address: invoice.address,
      paymentUri: buildPaymentUri(invoice.address, invoice.amountSatoshi),
      expiresAt: invoice.expiresAt,
    },
  });
});
