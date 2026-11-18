import { Router } from "express";
import { z } from "zod";
import { requireMerchantKey } from "../../middleware/require-merchant-key.js";
import { findInvoiceById } from "../../invoice/invoice.function.js";
import { askedAmount } from "../../invoice/payment-rules.js";
import { lockedRateView, priceView } from "../../invoice/pricing.js";

export const invoiceStatusRouter = Router();

const invoiceIdSchema = z.object({
  id: z.string(),
});
invoiceStatusRouter.get("/:id", requireMerchantKey, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const merchant = req.merchant;

  if (!merchant)
    return res.status(401).json({
      error: {
        code: "INVALID_MERCHANT_KEY",
        message: "merchant key is missing or invalid",
      },
    });

  const parsed = invoiceIdSchema.safeParse(req.params);
  if (!parsed.success)
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });

  const { id } = parsed.data;

  const invoice = await findInvoiceById(id, merchant.user_id);

  if (!invoice)
    return res.status(404).json({
      error: {
        code: "INVOICE_NOT_FOUND",
        message: "invoice was not found",
      },
    });

  const payout = invoice.tx?.out
    ? {
        txId: invoice.tx.out,
        address: invoice.to_address,
        crypto: invoice.to_crypto,
        merchantAmount: invoice.received_amount,
        networkFee: invoice.network_fee,
        platformFee: invoice.platform_fee,
        completedAt: invoice.timestamps?.completed ?? null,
      }
    : null;

  return res.status(200).json({
    data: {
      invoiceId: invoice.invoice_id,
      status: invoice.status,
      currency: invoice.currency,
      crypto: invoice.crypto,
      amount: invoice.amount,
      askedAmount: askedAmount(invoice).toString(),
      feePaidByPayer: invoice.fee_paid_by_payer ?? false,
      amountFiat: invoice.amount_fiat,
      price: priceView(invoice),
      lockedRate: lockedRateView(invoice.locked_rate),
      paidAmount: invoice.paid_amount,
      address: invoice.address,
      lifetime: invoice.lifetime,
      createdAt: invoice.timestamps?.created ?? null,
      payout,
    },
  });

  
});
