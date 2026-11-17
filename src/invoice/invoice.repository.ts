import { randomUUID } from "crypto";
import { SealedSecret } from "../security/secret-envelope.js";
import { Invoice } from "../database/invoices.model.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };

export async function createInvoice(input: {
  userId: string;
  paymentUnits: bigint;
  askedAmount: bigint;
  feePaidByPayer: boolean;
  fiatUnits: bigint;
  address: string;
  encryptedPrivateKey: SealedSecret;
  crypto: string;
  payoutAddress: string;
  toCrypto: keyof typeof cryptos;
  lifetime: number;
  underpaid: number;
}) {
  const invoiceId = randomUUID();
  const now = Date.now();

  const result = await Invoice.create({
    invoice_id: invoiceId,
    user_id: input.userId,
    status: "waiting",
    currency: "usd",
    crypto: input.crypto,
    amount: input.paymentUnits.toString(),
    asked_amount: input.askedAmount.toString(),
    amount_fiat: input.fiatUnits.toString(),
    paid_amount: "0",
    address: input.address,
    to_crypto: input.toCrypto,
    to_address: input.payoutAddress,
    lifetime: input.lifetime,
    underpaid: input.underpaid,
    mode: "fixed",
    link: `/pay/${invoiceId}`,
    fee_paid_by_payer: input.feePaidByPayer,
    timestamps: { created: now, waiting: now },
    private: { private_key: input.encryptedPrivateKey },
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
  fiatUnits: bigint;
  offeredCoins: string[];
  lifetime: number;
  underpaid: number;
  feePaidByPayer: boolean;
}) {
  const invoiceId = randomUUID();
  const now = Date.now();

  const result = await Invoice.create({
    invoice_id: invoiceId,
    user_id: input.userId,
    status: "waiting",
    mode: "merchant_list",
    offered_coins: input.offeredCoins,
    currency: "usd",
    amount: "0",
    asked_amount: "0",
    amount_fiat: input.fiatUnits.toString(),
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
  address: string;
  encryptedPrivateKey: SealedSecret;
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
        address: input.address,
        to_address: input.payoutAddress,
        "private.private_key": input.encryptedPrivateKey,
        "timestamps.chosen": input.now,
      },
    },
  ).exec();
  return result.modifiedCount === 1;
}

/** Cancels an invoice nobody has paid yet. False once a payment was seen. */
export async function cancelUnpaidInvoice(invoiceId: string, now: number): Promise<boolean> {
  const result = await Invoice.updateOne(
    { invoice_id: invoiceId, status: "waiting", paid_amount: "0" },
    { $set: { status: "cancelled", "timestamps.cancelled": now } },
  ).exec();
  return result.modifiedCount === 1;
}
