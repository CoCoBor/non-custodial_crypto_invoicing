import { Router, type Response } from "express";
import { z } from "zod";

import type { AppDeps } from "../../app.js";
import { checkPayoutAddress } from "../../assets/payout-address.js";
import { Invoice } from "../../database/invoices.model.js";
import { User } from "../../database/users.model.js";
import { DepositUnavailableError } from "../../chains/adapter.js";
import { adapterFor } from "../../chains/registry.js";
import { cancelIfUnpaid } from "../../invoice/cancel.js";
import { recordChosenCoin } from "../../invoice/invoice.repository.js";
import { newDepositOrUnavailable, refuseWithoutDeposit } from "../../invoice/new-deposit.js";
import { askedAmountFor, refuseWithoutEstimate } from "../../invoice/payer-pays.js";
import { askedAmount } from "../../invoice/payment-rules.js";
import { lockPrice, lockedRateView, parsePriceUnit, priceView, type LockedRate } from "../../invoice/pricing.js";
import { publicRateLimit } from "../../middleware/public-rate-limit.js";
import { answerCancel } from "../cancel-response.js";

// The payer's page. No login: the invoice id (a random UUID) is the key, so
// nothing here may show the merchant's details or payout addresses.

const invoiceIdSchema = z.uuid();
const chooseSchema = z.object({ crypto: z.string().max(20) });

type PayerInvoice = {
  invoice_id: string;
  user_id: string;
  status?: string | null;
  mode?: string | null;
  offered_coins?: string[] | null;
  currency?: string | null;
  amount_fiat: string;
  locked_rate?: Partial<LockedRate> | null;
  crypto?: string | null;
  address?: string | null;
  amount: string;
  asked_amount?: string | null;
  fee_paid_by_payer?: boolean | null;
  fee_rate?: string | null;
  paid_amount?: string | null;
  lifetime: number;
  timestamps?: { waiting?: number | null; created?: number | null } | null;
};

function expiresAt(invoice: PayerInvoice): number {
  const start = invoice.timestamps?.waiting ?? invoice.timestamps?.created ?? 0;
  return start + invoice.lifetime * 60 * 1000;
}

function payerView(invoice: PayerInvoice) {
  const chosen = Boolean(invoice.crypto);
  return {
    invoiceId: invoice.invoice_id,
    status: invoice.status,
    mode: invoice.mode,
    currency: invoice.currency,
    amountFiat: invoice.amount_fiat,
    price: priceView(invoice),
    lockedRate: lockedRateView(invoice.locked_rate),
    expiresAt: new Date(expiresAt(invoice)).toISOString(),
    coins: invoice.mode === "merchant_list" && !chosen ? invoice.offered_coins ?? [] : [],
    payment: chosen
      ? {
          crypto: invoice.crypto,
          address: invoice.address,
          amount: askedAmount(invoice).toString(),
          paidAmount: invoice.paid_amount,
        }
      : null,
  };
}

function conflict(res: Response, code: string, message: string) {
  return res.status(409).json({ error: { code, message } });
}

async function findInvoice(id: string): Promise<PayerInvoice | undefined> {
  if (!invoiceIdSchema.safeParse(id).success) return undefined;
  return (await Invoice.findOne({ invoice_id: id }).lean().exec()) ?? undefined;
}

export function createPayRouter(deps: AppDeps) {
  const router = Router();

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(publicRateLimit);

  router.get("/:invoiceId", async (req, res) => {
    const invoice = await findInvoice(req.params.invoiceId);
    if (!invoice) {
      return res.status(404).json({
        error: { code: "INVOICE_NOT_FOUND", message: "invoice was not found" },
      });
    }
    return res.status(200).json({ data: payerView(invoice) });
  });

  router.post("/:invoiceId/choose", async (req, res) => {
    const invoice = await findInvoice(req.params.invoiceId);
    if (!invoice) {
      return res.status(404).json({
        error: { code: "INVOICE_NOT_FOUND", message: "invoice was not found" },
      });
    }
    const parsed = chooseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "INVALID_REQUEST", message: "request body is invalid" },
      });
    }
    const chain = adapterFor(parsed.data.crypto);
    const now = Date.now();

    if (invoice.mode !== "merchant_list" || invoice.crypto) {
      return conflict(res, "COIN_ALREADY_CHOSEN", "the coin for this invoice is already set");
    }
    if (invoice.status !== "waiting" || now >= expiresAt(invoice)) {
      return conflict(res, "INVOICE_NOT_OPEN", "this invoice can no longer be paid");
    }
    if (chain === undefined || !(invoice.offered_coins ?? []).includes(chain.asset)) {
      return conflict(res, "COIN_NOT_OFFERED", "this coin is not offered for this invoice");
    }
    const coin = chain.asset;

    // The merchant's payout address as it is now: they may have changed it.
    const merchant = await User.findOne({ user_id: invoice.user_id })
      .select("payout_addresses merchant_fee")
      .lean()
      .exec();
    const payoutAddress = merchant?.payout_addresses?.[coin];
    if (!merchant || !payoutAddress || checkPayoutAddress(coin, payoutAddress) !== "valid") {
      return conflict(res, "COIN_NOT_OFFERED", "this coin is not offered for this invoice");
    }

    // The rate is locked now, at the choice (spec story 47).
    const unit = parsePriceUnit(invoice.currency ?? undefined);
    const payment =
      unit === undefined
        ? "price_unavailable"
        : await lockPrice({
            unit,
            priceUnits: BigInt(invoice.amount_fiat),
            coin,
            getPrice: deps.getPrice,
            getUsdToFiat: deps.getUsdToFiat,
            now,
          });
    if (payment === "price_unavailable") {
      return res.status(503).json({
        error: { code: "PRICE_UNAVAILABLE", message: "no valid price" },
      });
    }

    const asked = await askedAmountFor({
      coin,
      invoiceAmount: payment.amount,
      feePaidByPayer: invoice.fee_paid_by_payer === true,
      merchantFee: invoice.fee_rate || merchant.merchant_fee,
      estimateNetworkCost: deps.estimateNetworkCost,
    });
    if (typeof asked !== "bigint") return refuseWithoutEstimate(res, coin, asked);

    const deposit = await newDepositOrUnavailable(chain);
    if (deposit instanceof DepositUnavailableError) return refuseWithoutDeposit(res, deposit);
    const recorded = await recordChosenCoin({
      invoiceId: invoice.invoice_id,
      crypto: coin,
      amount: payment.amount,
      askedAmount: asked,
      lockedRate: payment.rate,
      deposit,
      payoutAddress,
      now,
    });
    if (!recorded) {
      return conflict(res, "COIN_ALREADY_CHOSEN", "the coin for this invoice is already set");
    }

    return res.status(200).json({ data: payerView((await findInvoice(invoice.invoice_id))!) });
  });

  router.post("/:invoiceId/cancel", async (req, res) => {
    const invoice = await findInvoice(req.params.invoiceId);
    if (!invoice) {
      return res.status(404).json({
        error: { code: "INVOICE_NOT_FOUND", message: "invoice was not found" },
      });
    }
    return answerCancel(res, invoice.invoice_id, await cancelIfUnpaid(invoice, deps.chains, Date.now()));
  });

  return router;
}
