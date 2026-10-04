import { Router } from "express";
import { z } from "zod";
import { requireMerchantKey } from "../../middleware/require-merchant-key.js";
import bitcore from "bitcore-lib";
import * as priceFunc from "../../invoice/price.function.js";
import cryptos from "../../storage/cryptos.json" with { type: "json" };
import * as invoiceFunc from "../../invoice/invoice.function.js";
import * as invoiceRepo from "../../invoice/invoice.repository.js";
import { generateBtcAddress } from '../../crypto/btc.js';
export const createInvoiceRouter = Router();

const createSchema = z.object({
  amount: z.string().trim().min(1).max(100),
  lifetime: z.number().int().min(1).max(60).default(30),
});

createInvoiceRouter.post("/", requireMerchantKey, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const merchant = req.merchant;
  if (!merchant)
    return res
      .status(401)
      .json({
        code: "INVALID_MERCHANT_KEY",
        message: "merchant key is missing or invalid",
      });

  const parsed = createSchema.safeParse(req.body);

  if (!parsed.success)
    return res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "request body is invalid" },
    });

  const { amount, lifetime } = parsed.data;

  const payoutAddress = merchant.payout_addresses?.btc;

  if (
    !payoutAddress ||
    !bitcore.Address.isValid(payoutAddress, bitcore.Networks.livenet)
  ) {
    return res.status(409).json({
      error: {
        code: "PAYOUT_ADDRESS_REQUIRED",
        message: "save a valid Bitcoin mainnet payout address first",
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
    payoutAddress,
    lifetime,
  });

  return res.status(201).json({
    data: invoice,
  });
});
