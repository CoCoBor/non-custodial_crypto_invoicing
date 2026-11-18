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

/** How the payer's coin reaches the merchant in swap mode: the receive coin directly, any other through a swap. */
export function coinOptions(offeredCoins: string[], receiveCrypto: string) {
  return offeredCoins.map((crypto) => ({ crypto, payout: crypto === receiveCrypto ? "direct" : "swap" }));
}

/**
 * An invoice whose coin the payer picks later: no deposit address yet.
 * merchant_list: the coin is paid out as itself. swap: it is swapped into
 * `swap.receiveCrypto` (paid to `swap.receiveAddress`), except that coin itself.
 */
export async function createMerchantListInvoice(input: {
  userId: string;
  priceUnit: PriceUnit;
  priceUnits: bigint;
  offeredCoins: string[];
  lifetime: number;
  underpaid: number;
  feePaidByPayer: boolean;
  feeRate: string;
  swap?: { receiveCrypto: string; receiveAddress: string; maxLossBps: number };
}) {
  const invoiceId = randomUUID();
  const now = Date.now();
  const swap = input.swap;

  const result = await Invoice.create({
    invoice_id: invoiceId,
    user_id: input.userId,
    status: "waiting",
    mode: swap ? "swap" : "merchant_list",
    ...(swap && { to_crypto: swap.receiveCrypto, to_address: swap.receiveAddress, swap_max_loss_bps: swap.maxLossBps }),
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
    ...(swap && {
      receiveCrypto: result.to_crypto,
      toAddress: result.to_address,
      coinOptions: coinOptions(result.offered_coins, result.to_crypto),
    }),
    feePaidByPayer: result.fee_paid_by_payer,
    lifetime: result.lifetime,
    createdAt: now,
    link: result.link,
  };
}

/**
 * Records the payer's coin. False if one was already picked or the invoice is
 * no longer waiting. `toCrypto` is the coin paid out: the chosen one, or in
 * swap mode the receive coin.
 */
export async function recordChosenCoin(input: {
  invoiceId: string;
  crypto: string;
  toCrypto: string;
  amount: bigint;
  askedAmount: bigint;
  lockedRate: LockedRate;
  deposit: NewDeposit;
  payoutAddress: string;
  now: number;
}): Promise<boolean> {
  const result = await Invoice.updateOne(
    { invoice_id: input.invoiceId, mode: { $in: ["merchant_list", "swap"] }, crypto: "", status: "waiting" },
    {
      $set: {
        crypto: input.crypto,
        to_crypto: input.toCrypto,
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
