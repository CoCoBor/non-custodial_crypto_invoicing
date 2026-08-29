import { ObjectId } from "mongodb";

export const INVOICES_COLLECTION = "invoices";

export type InvoiceStatus =
  | "waiting"
  | "underpaid"
  | "confirming"
  | "confirmed"
  | "expired";

export interface InvoiceTimestamps {
  created: Date;
  waiting: Date | null;
  confirming: Date | null;
  confirmed: Date | null;
  expired: Date | null;
}

export interface InvoiceDocument {
  _id: ObjectId;
  publicId: string;
  accountId: ObjectId;
  status: InvoiceStatus;
  amountSatoshi: number;
  paidSatoshi: number;

  addressIndex: number;
  address: string;

  underpaidTolerancePercent: number;
  lifetimeMinutes: number;
  expiresAt: Date;

  timestamps: InvoiceTimestamps;
  createdAt: Date;
  updatedAt: Date;
}
