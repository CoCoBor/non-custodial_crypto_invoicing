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
import { randomBytes } from "crypto";
import { allocateBitcoinAddressIndex } from "../accounts/account.repository.js";

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
