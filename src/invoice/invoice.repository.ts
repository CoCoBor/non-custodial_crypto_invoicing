import { randomUUID } from "crypto";
import { SealedSecret } from "../security/secret-envelope.js";
import { Invoice } from "../database/invoices.model.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };

export async function createInvoice(input: {
  userId: string;
  paymentUnits: bigint;
  fiatUnits: bigint;
  address: string;
  encryptedPrivateKey: SealedSecret;
  crypto: string;
  payoutAddress: string;
  toCrypto: keyof typeof cryptos;
  lifetime: number;
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
    amount_fiat: input.fiatUnits.toString(),
    paid_amount: "0",
    address: input.address,
    to_crypto: input.toCrypto,
    to_address: input.payoutAddress,
    lifetime: input.lifetime,
    underpaid: 0,
    fee_paid_by_payer: false,
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
    amountFiat: amount_fiat,
    address,
    lifetime,
    createdAt: timestamps?.created,
    toCrypto: result.to_crypto,
    toAddress: result.to_address,
  };
}
