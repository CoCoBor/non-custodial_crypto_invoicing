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

// One incoming payment, as the chain data showed it (see "Chain adapter
// contract" in docs/domain.md). Amounts are integer strings in smallest units.
const paymentSchema = new Schema(
  {
    txid: { type: String, required: true },
    amount: { type: String, required: true },
    first_seen_at: { type: Number, required: true }, // unix ms
    confirmations: { type: Number, required: true },
    on_time: { type: Boolean, required: true },
    // Which payout of this deposit carried it: 0 = the merchant payout, n =
    // refund route n. Absent while it is still at the deposit.
    payout: { type: Number },
  },
  { _id: false },
);

const transferSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ["gas_top_up", "merchant_payout", "platform_fee", "refund_route", "swap_deposit"],
      required: true,
    },
    to: { type: String, required: true },
    amount: { type: String, required: true },
    txid: { type: String, required: true },
    status: { type: String, enum: ["pending", "confirmed", "failed"], required: true },
    // Which payout made it: n = refund route n; absent = the merchant payout.
    payout: { type: Number },
  },
  { _id: false },
);

// One payout of money that reached the deposit outside the merchant payout:
// partial money at expiry, or money after a cancel, expiry or completion (see
// "Refund routing" in docs/domain.md). Routes are numbered from 1, run one at
// a time, and each keeps its own checkpoint.
const refundRouteSchema = new Schema(
  {
    n: { type: Number, required: true },
    destination: { type: String, required: true },
    source: { type: String, enum: ["refund_address", "payout_address"], required: true },
    state: { type: String, enum: ["processing", "paid", "failed"], required: true },
    raw: { type: String, default: "", select: false }, // the adapter's saved checkpoint (PayoutCheckpoint.state)
    swept: { type: String, default: "0" }, // what left the deposit: destination + platform fee + network cost
    platform_fee: { type: String, default: "0" },
    network_fee: { type: String, default: "0" },
    started_at: { type: Number, required: true },
    settled_at: { type: Number, default: null },
    notified: { type: Boolean, default: false }, // announced by webhook; see src/webhooks/webhook-pass.ts
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    invoice_id: { type: String, required: true },
    user_id: { type: String, required: true },
    invoiceType: { type: String, default: "" },
    mode: { type: String, enum: ["fixed", "merchant_list"], default: "fixed" }, // fixed: merchant picked the coin; merchant_list: the payer picks one of offered_coins
    offered_coins: { type: [String], default: [] }, // merchant_list: coins the payer may pick
    status: { type: String, enum: INVOICE_STATUSES, default: "" }, // waiting, underpaid, confirming, confirmed, processing, completed, failed, expired, cancelled
    lifetime: { type: Number, default: 0 }, // lifetime in minutes within 1-60 minutes, default: 30
    underpaid: { type: Number, default: 0 }, // Allowed underpayment percentage before invoice is considered unpaid, default: 0
    fee_paid_by_payer: { type: Boolean, default: false }, // false = merchant covers transaction + platform fees, true = payer covers transaction + platform fees, default = false
    currency: { type: String, default: "usd" }, // invoice currency
    amount: { type: String, required: true }, // invoice amount
    asked_amount: { type: String, default: "" }, // what the payer is asked to send: amount, plus the fees in payer-pays mode; see askedAmount()
    amount_fiat: { type: String, required: true }, // invoice amount in the invoice currency
    paid_amount: { type: String, default: "0" }, // amount payer paid
    paid_amount_fiat: { type: Number, default: 0 }, // amount payer paid in the invoice currency
    remainder_amount: { type: Number, default: 0 }, // amount payer must pay for invoice to be confirmed
    remainder_amount_fiat: { type: Number, default: 0 }, // amount payer must pay for invoice to be confirmed in the invoice currency
    received_amount: { type: String, default: "0" }, // amount sent to merchant after all fees
    received_amount_fiat: { type: String, default: null }, // amount sent to merchant after all fees in the invoice currency
    network_fee: { type: String, default: "0" }, // fee to transfer the received asset to the merchant
    platform_fee: { type: String, default: "0" }, // fee charged by the platform, based on user's merchant fee
    fee_rate: { type: String, default: "" }, // the merchant's fee rate when the invoice was made; "" on older invoices, which use the merchant's current rate
    swap_fee: { type: Number, default: 0 }, // if to_crypto is another crypto and NEAR Intents is used, fee = amount transferred - network fees - near estimated receive quote
    review_reason: { type: String, default: "" },
    notified_status: { type: String, default: "" }, // last status announced by webhook; see src/webhooks/webhook-pass.ts
    outcome: {
      type: String,
      enum: ["", "partially_paid", "too_small_to_forward", "held_for_manual_handling"],
      default: "",
    }, // what is left to handle after the status, e.g. money from a partly paid, expired invoice
    outcome_version: { type: Number, default: 0 }, // counts outcome changes made without a status change; each is one webhook
    notified_outcome_version: { type: Number, default: 0 },
    watch_until: { type: Number, default: null }, // unix ms: closed (expired, cancelled, completed) + 7 days; null for invoices closed before the watch existed
    watch_checked_at: { type: Number, default: null },
    watch_done: { type: Boolean, default: false },
    watch_version: { type: Number, default: 0 }, // compare-and-set token for the closed-invoice watch
    refund_routes: { type: [refundRouteSchema], default: [] },
    crypto: { type: String, default: "" }, // cryptocurrency ticker
    address: { type: String, default: "" }, // invoice payment address
    to_crypto: { type: String, default: "" }, // cryptocurrency ticker to convert to
    to_address: { type: String, default: "" }, // address to send to after invoice completed
    link: { type: String, default: "" }, // invoice payment link
    bot_link: { type: String, default: "" }, // invoice payment link in telegram bot
    return_url: { type: String, default: "" }, // url the user returns to after invoice is completed
    callback_url: { type: String, default: "" }, // url where transaction notifications are sent to
    payments: { type: [paymentSchema], default: [] },
    transfers: { type: [transferSchema], default: [] },
    tx: {
      in: { type: String, default: "" },
      out: { type: String, default: "" }, // txid
      raw: { type: String, default: "", select: false }, // txhex; for chains behind an adapter, the adapter's saved payout state (PayoutCheckpoint.state)
      platform_out: { type: String, default: "" }, 
      platform_raw: { type: String, default: "", select: false }, 
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
      chosen: { type: Number, default: null },
      cancelled: { type: Number, default: null },
    }, // time in unix ms
    subaddress_index: { type: Number, default: null }, // XMR: the deposit is this subaddress of the platform wallet, so there is no key
    private: {
      // A deposit address always comes with its key. A merchant_list invoice
      // has neither until the payer picks a coin.
      private_key: {
        type: encryptedKeySchema,
        required(this: { address?: string; subaddress_index?: number | null }) {
          return Boolean(this.address) && this.subaddress_index == null;
        },
        select: false,
      },
    },
  },
  { collection: "invoices" },
);
invoiceSchema.index({ invoice_id: 1 }, { unique: true });
export const Invoice = model("Invoice", invoiceSchema);
