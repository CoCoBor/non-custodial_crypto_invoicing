import { randomUUID } from "crypto";
import type { NewDeposit } from "../chains/adapter.js";
import { Invoice } from "../database/invoices.model.js";
import { lockedRateView, priceView, type LockedRate, type PriceUnit } from "./pricing.js";
import { watchUntil } from "./watch-window.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };

// How the backend controls the deposit: its sealed key, or (XMR) the
// platform wallet's subaddress index.
function depositKeyFields(deposit: NewDeposit) {
  return deposit.key.kind === "sealed_key"
    ? { private: { private_key: deposit.key.sealed } }
    : { subaddress_index: deposit.key.index };
}

export async function createInvoice(input: {
  userId: string;
  paymentUnits: bigint;
  askedAmount: bigint;
  feePaidByPayer: boolean;
  priceUnit: PriceUnit;
  priceUnits: bigint;
  lockedRate: LockedRate;
  deposit: NewDeposit;
  crypto: string;
  payoutAddress: string;
  toCrypto: keyof typeof cryptos;
  lifetime: number;
  underpaid: number;
  feeRate: string;
}) {
  const invoiceId = randomUUID();
  const now = Date.now();

  const result = await Invoice.create({
    invoice_id: invoiceId,
    user_id: input.userId,
    status: "waiting",
    currency: input.priceUnit,
    crypto: input.crypto,
    amount: input.paymentUnits.toString(),
    asked_amount: input.askedAmount.toString(),
    amount_fiat: input.priceUnits.toString(),
    locked_rate: input.lockedRate,
    paid_amount: "0",
    address: input.deposit.address,
    ...depositKeyFields(input.deposit),
    to_crypto: input.toCrypto,
    to_address: input.payoutAddress,
    lifetime: input.lifetime,
    underpaid: input.underpaid,
    mode: "fixed",
    link: `/pay/${invoiceId}`,
    fee_paid_by_payer: input.feePaidByPayer,
    fee_rate: input.feeRate,
    timestamps: { created: now, waiting: now },
  });

  const {
    invoice_id,
    status,
    currency,
    crypto,
    amount,
    amount_fiat,
    address,
    lifetime,
    timestamps,
  } = result;

  return {
    invoiceId: invoice_id,
    status,
    currency,
    crypto,
    amount,
    askedAmount: result.asked_amount,
    feePaidByPayer: result.fee_paid_by_payer,
    amountFiat: amount_fiat,
    price: priceView(result),
    lockedRate: lockedRateView(result.locked_rate),
    address,
    lifetime,
    createdAt: timestamps?.created,
    toCrypto: result.to_crypto,
    toAddress: result.to_address,
    link: result.link,
  };
}

/** An invoice whose coin the payer picks later: no deposit address yet. */
export async function createMerchantListInvoice(input: {
  userId: string;
  priceUnit: PriceUnit;
  priceUnits: bigint;
  offeredCoins: string[];
  lifetime: number;
  underpaid: number;
  feePaidByPayer: boolean;
  feeRate: string;
}) {
  const invoiceId = randomUUID();
  const now = Date.now();

  const result = await Invoice.create({
    invoice_id: invoiceId,
    user_id: input.userId,
    status: "waiting",
    mode: "merchant_list",
    fee_rate: input.feeRate,
    offered_coins: input.offeredCoins,
    currency: input.priceUnit,
    amount: "0",
    asked_amount: "0",
    amount_fiat: input.priceUnits.toString(),
    paid_amount: "0",
    lifetime: input.lifetime,
    underpaid: input.underpaid,
    fee_paid_by_payer: input.feePaidByPayer,
    link: `/pay/${invoiceId}`,
    timestamps: { created: now, waiting: now },
  });

  return {
    invoiceId,
    status: result.status,
    mode: result.mode,
    currency: result.currency,
    amountFiat: result.amount_fiat,
    price: priceView(result),
    offeredCoins: result.offered_coins,
    feePaidByPayer: result.fee_paid_by_payer,
    lifetime: result.lifetime,
    createdAt: now,
    link: result.link,
  };
}

/** Records the payer's coin. False if one was already picked or the invoice is no longer waiting. */
export async function recordChosenCoin(input: {
  invoiceId: string;
  crypto: string;
  amount: bigint;
  askedAmount: bigint;
  lockedRate: LockedRate;
  deposit: NewDeposit;
  payoutAddress: string;
  now: number;
}): Promise<boolean> {
  const result = await Invoice.updateOne(
    { invoice_id: input.invoiceId, mode: "merchant_list", crypto: "", status: "waiting" },
    {
      $set: {
        crypto: input.crypto,
        to_crypto: input.crypto,
        amount: input.amount.toString(),
        asked_amount: input.askedAmount.toString(),
        locked_rate: input.lockedRate,
        address: input.deposit.address,
        ...(input.deposit.key.kind === "sealed_key"
          ? { "private.private_key": input.deposit.key.sealed }
          : { subaddress_index: input.deposit.key.index }),
        to_address: input.payoutAddress,
        "timestamps.chosen": input.now,
      },
    },
  ).exec();
  return result.modifiedCount === 1;
}

/**
 * Cancels an invoice nobody has paid yet, whose deposit is still `address`
 * (the one the chain was asked about). False once a payment was recorded or
 * a coin was picked meanwhile.
 */
export async function cancelUnpaidInvoice(invoiceId: string, address: string, now: number): Promise<boolean> {
  const result = await Invoice.updateOne(
    { invoice_id: invoiceId, status: "waiting", paid_amount: "0", address },
    { $set: { status: "cancelled", "timestamps.cancelled": now, watch_until: watchUntil(now) } },
  ).exec();
  return result.modifiedCount === 1;
}
