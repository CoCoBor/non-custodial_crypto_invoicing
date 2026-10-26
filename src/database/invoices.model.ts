import { Schema, model } from "mongoose";

const encryptedKeySchema = new Schema(
  {
    keyVersion: { type: Number, required: true },
    initialisationVector: { type: Buffer, required: true },
    authenticationTag: { type: Buffer, required: true },
    ciphertext: { type: Buffer, required: true },
  },
  { _id: false },
);

const INVOICE_STATUSES = [
  "waiting",
  "underpaid",
  "confirming",
  "confirmed",
  "processing",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const;

const invoiceSchema = new Schema(
  {
    invoice_id: { type: String, required: true },
    user_id: { type: String, required: true },
    invoiceType: { type: String, default: "" },
    status: { type: String, enum: INVOICE_STATUSES, default: "" }, // waiting, underpaid, confirming, confirmed, processing, completed, failed, expired, cancelled
    lifetime: { type: Number, default: 0 }, // lifetime in minutes within 1-60 minutes, default: 30
    underpaid: { type: Number, default: 0 }, // Allowed underpayment percentage before invoice is considered unpaid, default: 0
    fee_paid_by_payer: { type: Boolean, default: false }, // false = merchant covers transaction + platform fees, true = payer covers transaction + platform fees, default = false
    currency: { type: String, default: "usd" }, // invoice currency
    amount: { type: String, required: true }, // invoice amount
    amount_fiat: { type: String, required: true }, // invoice amount in the invoice currency
    paid_amount: { type: String, default: "0" }, // amount payer paid
    paid_amount_fiat: { type: Number, default: 0 }, // amount payer paid in the invoice currency
    remainder_amount: { type: Number, default: 0 }, // amount payer must pay for invoice to be confirmed
    remainder_amount_fiat: { type: Number, default: 0 }, // amount payer must pay for invoice to be confirmed in the invoice currency
    received_amount: { type: String, default: "0" }, // amount sent to merchant after all fees
    received_amount_fiat: { type: String, default: null }, // amount sent to merchant after all fees in the invoice currency
    network_fee: { type: String, default: "0" }, // fee to transfer the received asset to the merchant
    platform_fee: { type: String, default: "0" }, // fee charged by the platform, based on user's merchant fee
    swap_fee: { type: Number, default: 0 }, // if to_crypto is another crypto and NEAR Intents is used, fee = amount transferred - network fees - near estimated receive quote
    review_reason: { type: String, default: "" },
    crypto: { type: String, default: "" }, // cryptocurrency ticker
    address: { type: String, default: "" }, // invoice payment address
    to_crypto: { type: String, default: "" }, // cryptocurrency ticker to convert to
    to_address: { type: String, default: "" }, // address to send to after invoice completed
    link: { type: String, default: "" }, // invoice payment link
    bot_link: { type: String, default: "" }, // invoice payment link in telegram bot
    return_url: { type: String, default: "" }, // url the user returns to after invoice is completed
    callback_url: { type: String, default: "" }, // url where transaction notifications are sent to
    tx: {
      in: { type: String, default: "" },
      out: { type: String, default: "" },
      raw: { type: String, default: "", select: false },
      platform_out: { type: String, default: "" }, //use when swap
      platform_raw: { type: String, default: "", select: false }, //use when swap
    },
    swap: {
      deposit_address: { type: String, default: "" },
      status: { type: String, default: "" },
      deadline: { type: String, default: "" },
      destination_txids: { type: [String], default: [] },
      origin_txids: { type: [String], default: [] },
      refunded_amount: { type: String, default: "0" },

      quote_response: {
        type: Schema.Types.Mixed,
        default: null,
        select: false,
      },
    },
    timestamps: {
      created: { type: Number, default: null },
      waiting: { type: Number, default: null },
      confirming: { type: Number, default: null },
      confirmed: { type: Number, default: null },
      processing: { type: Number, default: null },
      completed: { type: Number, default: null },
      failed: { type: Number, default: null },
      expired: { type: Number, default: null },
    }, // time in unix ms
    private: {
      private_key: { type: encryptedKeySchema, required: true, select: false },
    },
  },
  { collection: "invoices" },
);
invoiceSchema.index({ invoice_id: 1 }, { unique: true });
export const Invoice = model("Invoice", invoiceSchema);
