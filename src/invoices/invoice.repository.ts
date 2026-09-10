import { Db, ObjectId } from "mongodb";
import {
  BitcoinAccountKey,
  deriveReceiveAddress,
} from "../chains/bitcoin/extended-key.js";
import {
  InvoiceDocument,
  INVOICES_COLLECTION,
} from "./invoice.model.js";
import { base32Encode } from "../security/totp.js";
import { randomBytes, randomUUID } from "crypto";
import { allocateBitcoinAddressIndex } from "../accounts/account.repository.js";
import { Invoice } from "./invoice.schema.js";
import { BitcoinDepositAddress } from "../chains/bitcoin/deposit-address.js";

export interface CreateInvoiceInput {
  accountId: ObjectId;
  accountKey: BitcoinAccountKey;
  amountSatoshi: number;
  lifetimeMinutes: number;
  underpaidTolerancePercent: number;
}

function generateInvoicePublicId(): string {
  return `inv_${base32Encode(randomBytes(10))}`;
}

export async function createInvoice(
  database: Db,
  input: CreateInvoiceInput,
): Promise<InvoiceDocument | undefined> {
  const {
    accountId,
    accountKey,
    amountSatoshi,
    lifetimeMinutes,
    underpaidTolerancePercent,
  } = input;

  const addressIndex = await allocateBitcoinAddressIndex(database, accountId);
  if (addressIndex === undefined) {
    return undefined;
  }

  const address = deriveReceiveAddress(accountKey, addressIndex);
  if (address === undefined) {
    return undefined;
  }

  const collection = database.collection<InvoiceDocument>(INVOICES_COLLECTION);
  const date = new Date();
  const document: InvoiceDocument = {
    _id: new ObjectId(),
    publicId: generateInvoicePublicId(),
    accountId,
    status: "waiting",
    amountSatoshi,
    paidSatoshi: 0,

    addressIndex,
    address: address,

    underpaidTolerancePercent,
    lifetimeMinutes,
    expiresAt: new Date(date.getTime() + lifetimeMinutes * 60 * 1000),

    timestamps: {
      created: date,
      waiting: date,
      confirming: null,
      confirmed: null,
      expired: null,
    },
    createdAt: date,
    updatedAt: date,
  };

  await collection.insertOne(document);

  return document;
}


export async function findInvoiceByPublicId(
  database: Db,
  invoiceId: string,
): Promise<InvoiceDocument | null> {
  const collection = database.collection<InvoiceDocument>(INVOICES_COLLECTION);
  return collection.findOne({ publicId: invoiceId });
}

export interface PreparedInvoiceInput {
  currency: string;
  crypto?: string;
  amount: number | null;
  amount_fiat: number | null;

  lifetime: number;
  underpaid: number;
  fee_paid_by_payer: boolean;

  network_fee: number;
  platform_fee: number;
  swap_fee: number;

  deposit?: BitcoinDepositAddress

  merchantKey: string;

  to_crypto?: string;
  to_address?: string;
  return_url?: string;
  callback_url?: string;

  paymentUrl: string;
  paymentBotPrefix: string;
}

export async function savePreparedInvoice(
  input: PreparedInvoiceInput,
) {
  const id = randomUUID();
  const now = Date.now();

  const saved = await Invoice.findOneAndUpdate(
    { id },
    {
      $set: {
        id,
        status: "waiting",

        currency: input.currency,
        crypto: input.crypto ?? "",
        amount: input.amount,
        amount_fiat: input.amount_fiat,

        lifetime: input.lifetime,
        underpaid: input.underpaid,
        fee_paid_by_payer: input.fee_paid_by_payer,

        network_fee: input.network_fee,
        platform_fee: input.platform_fee,
        swap_fee: input.swap_fee,

        address: input.deposit?.address ?? "",
        to_crypto: input.to_crypto ?? "",
        to_address: input.to_address ?? "",

        link: `${input.paymentUrl}/${id}`,
        bot_link: `${input.paymentBotPrefix}${id}`,
        return_url: input.return_url ?? "",
        callback_url: input.callback_url ?? "",

        timestamps: {
          created: now,
          waiting: now,
        },

        private: {
          private_key: input.deposit?.encryptedPrivateKey ?? null,
          merchant_key: input.merchantKey,
        },
      },
    },
    {
      upsert: true,
      returnDocument: "after",
    },
  )
    .select("-private")
    .lean();

  if (!saved) {
    throw new Error("Invoice was not returned after saving");
  }

  return saved;
}