import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireMerchantKey } from "../../middleware/require-merchant-key.js";
import { ASSET_IDS, checkPayoutAddress } from "../../assets/payout-address.js";
import * as invoiceRepo from "../../invoice/invoice.repository.js";
import { adapterFor, depositAssets } from "../../chains/registry.js";
import { toleranceBasisPoints } from "../../invoice/payment-rules.js";
import { lockPrice, parsePriceAmount, parsePriceUnit, type PriceUnit } from "../../invoice/pricing.js";
import { askedAmountFor, refuseWithoutEstimate } from "../../invoice/payer-pays.js";
import { newDepositOrUnavailable, refuseWithoutDeposit } from "../../invoice/new-deposit.js";
import { DepositUnavailableError } from "../../chains/adapter.js";
import type { AppDeps } from "../../app.js";
import { DEFAULT_SWAP_MAX_LOSS_BPS } from "../../invoice/swap-payout.js";

const commonFields = {
  amount: z.string().trim().min(1).max(100),
  currency: z.string().max(20).optional(),
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

const swapSchema = z.object({
  ...commonFields,
  mode: z.literal("swap"),
  to_crypto: z.enum(ASSET_IDS),
  coins: z.array(z.enum(ASSET_IDS)).min(1).optional(),
});

type Merchant = NonNullable<Request["merchant"]>;

function invalidRequest(res: Response) {
  return res.status(400).json({
    error: { code: "INVALID_REQUEST", message: "request body is invalid" },
  });
}

function unsupportedCurrency(res: Response) {
  return res.status(400).json({
    error: {
      code: "UNSUPPORTED_CURRENCY",
      message: "currency must be USD, EUR, GBP, INR, PKR, VND, BRL, NGN, IDR, UAH, PHP, MYR or an asset id",
    },
  });
}

function invalidPayment(res: Response) {
  return res.status(400).json({
    error: { code: "INVALID_PAYMENT", message: "no valid payment" },
  });
}

/** The price unit and the price in its smallest units, or the 400 already sent. */
function parsePrice(
  res: Response,
  body: { currency?: string; amount: string },
): { unit: PriceUnit; units: bigint } | undefined {
  const unit = parsePriceUnit(body.currency);
  if (unit === undefined) {
    unsupportedCurrency(res);
    return undefined;
  }
  const units = parsePriceAmount(unit, body.amount);
  if (units === undefined) {
    invalidPayment(res);
    return undefined;
  }
  return { unit, units };
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

    if (req.body?.mode === "merchant_list") return await createMerchantListInvoice(req, res, merchant);
    if (req.body?.mode === "swap") return await createSwapInvoice(req, res, merchant, deps);
    return await createFixedCoinInvoice(req, res, merchant, deps);
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

  const { lifetime, crypto, to_crypto, underpaid, fee_paid_by_payer } = parsed.data;
  const price = parsePrice(res, parsed.data);
  if (price === undefined) return res;

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

  // A fixed-coin deposit pays out only as itself; an invoice for another
  // payout coin would leave the payer's coins stuck at the deposit.
  if (!chain.canPayOutAs(to_crypto)) {
    return res.status(409).json({
      error: {
        code: "PAYOUT_NOT_SUPPORTED",
        message: `a fixed-coin invoice pays out in the coin paid (${chain.asset}); use mode "swap" to receive ${to_crypto}`,
      },
    });
  }

  const depositAsset = chain.asset;
  const payment = await lockPrice({
    unit: price.unit,
    priceUnits: price.units,
    coin: depositAsset,
    getPrice: deps.getPrice,
    getUsdToFiat: deps.getUsdToFiat,
    now: Date.now(),
  });

  if (payment === "price_unavailable")
    return res.status(503).json({
      error: {
        code: "PRICE_UNAVAILABLE",
        message: "no valid price",
      },
    });

  const askedAmount = await askedAmountFor({
    coin: depositAsset,
    invoiceAmount: payment.amount,
    feePaidByPayer: fee_paid_by_payer,
    merchantFee: merchant.merchant_fee,
    estimateNetworkCost: deps.estimateNetworkCost,
  });
  if (typeof askedAmount !== "bigint") return refuseWithoutEstimate(res, depositAsset, askedAmount);

  const deposit = await newDepositOrUnavailable(chain);
  if (deposit instanceof DepositUnavailableError) return refuseWithoutDeposit(res, deposit);

  const invoice = await invoiceRepo.createInvoice({
    userId: merchant.user_id,
    paymentUnits: payment.amount,
    askedAmount,
    feePaidByPayer: fee_paid_by_payer,
    priceUnit: price.unit,
    priceUnits: price.units,
    lockedRate: payment.rate,
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
  const { lifetime, underpaid, coins, fee_paid_by_payer } = parsed.data;
  const price = parsePrice(res, parsed.data);
  if (price === undefined) return res;

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
    priceUnit: price.unit,
    priceUnits: price.units,
    offeredCoins,
    lifetime,
    underpaid,
    feePaidByPayer: fee_paid_by_payer,
    feeRate: merchant.merchant_fee,
  });

  return res.status(201).json({ data: invoice });
}

// The payer picks any coin that can reach the merchant's receive coin: the
// receive coin itself (paid out directly), or one the swap provider can swap
// into it. Each needs a chain adapter, so it can be detected and paid out.
async function createSwapInvoice(req: Request, res: Response, merchant: Merchant, deps: AppDeps) {
  const parsed = swapSchema.safeParse(req.body);
  if (!parsed.success) return invalidRequest(res);
  const { lifetime, underpaid, coins, fee_paid_by_payer, to_crypto: receive } = parsed.data;
  const price = parsePrice(res, parsed.data);
  if (price === undefined) return res;

  // XMR has no swap provider until ticket 24 (Exolix) adds one to the swap port.
  const deposits = depositAssets();
  const swappable = deposits.filter((coin) => coin !== receive && deps.swap.supports(coin, receive));
  if (adapterFor(receive) === undefined || swappable.length === 0) {
    return res.status(409).json({
      error: { code: "RECEIVE_COIN_NOT_SUPPORTED", message: `swap mode can't pay out ${receive} yet` },
    });
  }

  const receiveAddress = merchant.payout_addresses?.[receive];
  if (!receiveAddress || checkPayoutAddress(receive, receiveAddress) !== "valid") {
    return res.status(409).json({
      error: { code: "PAYOUT_ADDRESS_REQUIRED", message: `save a valid ${receive} payout address first` },
    });
  }

  const requested: readonly string[] = coins ?? deposits;
  const offeredCoins = deposits.filter(
    (coin) => requested.includes(coin) && (coin === receive || swappable.includes(coin)),
  );
  if (offeredCoins.length === 0) {
    return res.status(409).json({
      error: { code: "NO_COINS_AVAILABLE", message: `none of these coins can be paid out as ${receive}` },
    });
  }

  const maxLoss = merchant.swap_max_loss_bps;
  const invoice = await invoiceRepo.createMerchantListInvoice({
    userId: merchant.user_id,
    priceUnit: price.unit,
    priceUnits: price.units,
    offeredCoins,
    lifetime,
    underpaid,
    feePaidByPayer: fee_paid_by_payer,
    feeRate: merchant.merchant_fee,
    swap: {
      receiveCrypto: receive,
      receiveAddress,
      maxLossBps: Number.isInteger(maxLoss) && maxLoss >= 50 && maxLoss <= 500 ? maxLoss : DEFAULT_SWAP_MAX_LOSS_BPS,
    },
  });

  return res.status(201).json({ data: invoice });
}
