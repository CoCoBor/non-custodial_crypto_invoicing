import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireMerchantKey } from "../../middleware/require-merchant-key.js";
import { ASSET_IDS, checkPayoutAddress } from "../../assets/payout-address.js";
import * as priceFunc from "../../invoice/price.function.js";
import cryptos from "../../storage/cryptos.json" with { type: "json" };
import * as invoiceRepo from "../../invoice/invoice.repository.js";
import { adapterFor, depositAssets } from "../../chains/registry.js";
import { toleranceBasisPoints } from "../../invoice/payment-rules.js";
import { decimalStrToBigInt } from "../../invoice/money.function.js";
import { askedAmountFor, refuseWithoutEstimate } from "../../invoice/payer-pays.js";
import type { AppDeps } from "../../app.js";

const commonFields = {
  amount: z.string().trim().min(1).max(100),
  lifetime: z.number().int().min(1).max(60).default(30),
  underpaid: z
    .number()
    .refine((percent) => toleranceBasisPoints(percent) !== undefined)
    .default(0),
  fee_paid_by_payer: z.boolean().default(false),
};

const fixedCoinSchema = z.object({
  ...commonFields,
  mode: z.literal("fixed").default("fixed"),
  crypto: z.string().trim().min(1).max(100),
  to_crypto: z.enum(ASSET_IDS),
});

const merchantListSchema = z.object({
  ...commonFields,
  mode: z.literal("merchant_list"),
  coins: z.array(z.enum(ASSET_IDS)).min(1).optional(),
});

type Merchant = NonNullable<Request["merchant"]>;

function invalidRequest(res: Response) {
  return res.status(400).json({
    error: { code: "INVALID_REQUEST", message: "request body is invalid" },
  });
}

export function createInvoiceRouter(deps: AppDeps) {
  const router = Router();

  router.post("/", requireMerchantKey, async (req, res) => {
    res.set("Cache-Control", "no-store");

    const merchant = req.merchant;
    if (!merchant)
      return res.status(401).json({
        code: "INVALID_MERCHANT_KEY",
        message: "merchant key is missing or invalid",
      });

    return req.body?.mode === "merchant_list"
      ? await createMerchantListInvoice(req, res, merchant)
      : await createFixedCoinInvoice(req, res, merchant, deps);
  });

  return router;
}

async function createFixedCoinInvoice(
  req: Request,
  res: Response,
  merchant: Merchant,
  deps: AppDeps,
) {
  const parsed = fixedCoinSchema.safeParse(req.body);
  if (!parsed.success) return invalidRequest(res);

  const { amount, lifetime, crypto, to_crypto, underpaid, fee_paid_by_payer } = parsed.data;

  // Fixed-coin invoices can only take BTC deposits today; never quietly make
  // a BTC invoice for a payer who was told to pay something else.
  const chain = adapterFor(crypto);
  if (chain === undefined) {
    return res.status(409).json({
      error: {
        code: "DEPOSIT_COIN_NOT_SUPPORTED",
        message: `fixed-coin invoices can't take ${crypto} deposits yet`,
      },
    });
  }

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
  if (!chain.canPayOutAs(to_crypto)) {
    return res.status(409).json({
      error: {
        code: "PAYOUT_NOT_SUPPORTED",
        message: `${to_crypto} payouts are not supported yet`,
      },
    });
  }

  const depositAsset = chain.asset;
  const price = await deps.getPrice(depositAsset, "usd");

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
    coinDecimals: cryptos[depositAsset].decimal,
  }); //return paymentUnits & fiatUnits

  if (payment === undefined)
    return res.status(400).json({
      error: {
        code: "INVALID_PAYMENT",
        message: "no valid payment",
      },
    });

  const askedAmount = await askedAmountFor({
    coin: depositAsset,
    invoiceAmount: payment.paymentUnits,
    feePaidByPayer: fee_paid_by_payer,
    merchantFee: merchant.merchant_fee,
    estimateNetworkCost: deps.estimateNetworkCost,
  });
  if (typeof askedAmount !== "bigint") return refuseWithoutEstimate(res, depositAsset, askedAmount);

  const deposit = await chain.newDeposit();

  const invoice = await invoiceRepo.createInvoice({
    userId: merchant.user_id,
    paymentUnits: payment.paymentUnits,
    askedAmount,
    feePaidByPayer: fee_paid_by_payer,
    fiatUnits: payment.fiatUnits,
    deposit,
    crypto: depositAsset,
    payoutAddress,
    toCrypto: to_crypto,
    lifetime,
    underpaid,
    feeRate: merchant.merchant_fee,
  });

  return res.status(201).json({
    data: invoice,
  });
}

// The payer picks the coin later, on the payment page. Offered: the coins
// the merchant has a valid payout address for that can be paid end to end.
async function createMerchantListInvoice(req: Request, res: Response, merchant: Merchant) {
  const parsed = merchantListSchema.safeParse(req.body);
  if (!parsed.success) return invalidRequest(res);
  const { amount, lifetime, underpaid, coins, fee_paid_by_payer } = parsed.data;

  const fiatUnits = decimalStrToBigInt(amount, 2);
  if (fiatUnits === undefined || fiatUnits <= 0n) {
    return res.status(400).json({
      error: { code: "INVALID_PAYMENT", message: "no valid payment" },
    });
  }

  const requested: readonly string[] = coins ?? depositAssets();
  const offeredCoins = depositAssets().filter(
    (coin) =>
      requested.includes(coin) &&
      checkPayoutAddress(coin, merchant.payout_addresses?.[coin]) === "valid",
  );
  if (offeredCoins.length === 0) {
    return res.status(409).json({
      error: {
        code: "NO_COINS_AVAILABLE",
        message: "save a valid payout address for a coin the payer can use first",
      },
    });
  }

  const invoice = await invoiceRepo.createMerchantListInvoice({
    userId: merchant.user_id,
    fiatUnits,
    offeredCoins,
    lifetime,
    underpaid,
    feePaidByPayer: fee_paid_by_payer,
    feeRate: merchant.merchant_fee,
  });

  return res.status(201).json({ data: invoice });
}
