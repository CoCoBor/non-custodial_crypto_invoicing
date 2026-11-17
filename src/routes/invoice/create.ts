import { Router } from "express";
import { z } from "zod";
import { requireMerchantKey } from "../../middleware/require-merchant-key.js";
import { ASSET_IDS, checkPayoutAddress } from "../../assets/payout-address.js";
import * as priceFunc from "../../invoice/price.function.js";
import cryptos from "../../storage/cryptos.json" with { type: "json" };
import * as invoiceFunc from "../../invoice/invoice.function.js";
import * as invoiceRepo from "../../invoice/invoice.repository.js";
import { generateBtcAddress } from "../../crypto/btc.js";
import { canPayOutFromBtcDeposit } from "../../transactions/btc.js";
import { toleranceBasisPoints } from "../../invoice/payment-rules.js";
export const createInvoiceRouter = Router();

const createSchema = z.object({
  amount: z.string().trim().min(1).max(100),
  lifetime: z.number().int().min(1).max(60).default(30),
  crypto: z.string().trim().min(1).max(100),
  to_crypto: z.enum(ASSET_IDS),
  underpaid: z
    .number()
    .refine((percent) => toleranceBasisPoints(percent) !== undefined)
    .default(0),
});

createInvoiceRouter.post("/", requireMerchantKey, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const merchant = req.merchant;
  if (!merchant)
    return res.status(401).json({
      code: "INVALID_MERCHANT_KEY",
      message: "merchant key is missing or invalid",
    });

  const parsed = createSchema.safeParse(req.body);

  if (!parsed.success)
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });

  const { amount, lifetime, to_crypto, underpaid } = parsed.data;

  const payoutAddress = merchant.payout_addresses?.[to_crypto];
  const addressCheck = checkPayoutAddress(to_crypto, payoutAddress);

  if (addressCheck === "unsupported") {
    return res.status(409).json({
      error: {
        code: "PAYOUT_NOT_SUPPORTED",
        message: `${to_crypto} payouts are not supported yet`,
      },
    });
  }

  if (addressCheck !== "valid" || !payoutAddress) {
    return res.status(409).json({
      error: {
        code: "PAYOUT_ADDRESS_REQUIRED",
        message: `save a valid ${to_crypto} payout address first`,
      },
    });
  }

  // The deposit below is BTC: an invoice whose payout coin a BTC deposit
  // can't be paid out as would leave the payer's BTC stuck at the deposit.
  if (!canPayOutFromBtcDeposit(to_crypto)) {
    return res.status(409).json({
      error: {
        code: "PAYOUT_NOT_SUPPORTED",
        message: `${to_crypto} payouts are not supported yet`,
      },
    });
  }

  const price = await priceFunc.getPrice("btc", "usd");

  if (price === undefined)
    return res.status(503).json({
      error: {
        code: "PRICE_UNAVAILABLE",
        message: "no valid price",
      },
    });

  const payment = priceFunc.getUsdToCrypto({
    fiatAmount: amount,
    fiatDecimals: 2,
    coinPrice: price,
    coinDecimals: cryptos.btc.decimal,
  }); //return paymentUnits & fiatUnits

  if (payment === undefined)
    return res.status(400).json({
      error: {
        code: "INVALID_PAYMENT",
        message: "no valid payment",
      },
    });

  const deposit = generateBtcAddress();

  const invoice = await invoiceRepo.createInvoice({
    userId: merchant.user_id,
    paymentUnits: payment.paymentUnits,
    fiatUnits: payment.fiatUnits,
    address: deposit.address,
    encryptedPrivateKey: deposit.encryptedPrivateKey,
    crypto: "btc",
    payoutAddress,
    toCrypto: to_crypto,
    lifetime,
    underpaid,
  });

  return res.status(201).json({
    data: invoice,
  });
});
