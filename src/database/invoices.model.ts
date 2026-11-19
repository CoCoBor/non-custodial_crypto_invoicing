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

// One status change, written in the same update as the change itself, so the
// webhook pass can announce every change in order (src/webhooks/webhook-pass.ts).
const statusChangeSchema = new Schema(
  {
    from: { type: String, default: "" }, // "" for the first status
    to: { type: String, required: true },
    at: { type: Number, required: true }, // unix ms
  },
  { _id: false },
);

const transferSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ["gas_top_up", "gas_sweep", "merchant_payout", "platform_fee", "refund_route", "swap_deposit"],
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

// A swap through a provider (src/swap/swap-port.ts): the deposit's coin is
// sent to the provider's deposit address, and the provider delivers the
// receive coin to the merchant. Amounts are integer strings in smallest units:
// amount_in and amount_refunded in the deposit coin, the others in the receive
// coin. See "Swap mode" in docs/domain.md.
const swapFields = {
  provider: { type: String, default: "" }, // "near_intents" or "exolix"; "" on some swaps saved before ticket 24 means NEAR
  provider_swap_id: { type: String, default: "" }, // the provider's own id (Exolix looks swaps up by it)
  deposit_address: { type: String, default: "" },
  recipient: { type: String, default: "" },
  receive_crypto: { type: String, default: "" },
  status: { type: String, default: "" }, // the provider's: PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED
  deadline: { type: String, default: "" }, // ISO time; a deposit landing later is refunded
  amount_in: { type: String, default: "0" },
  min_amount_out: { type: String, default: "" },
  amount_delivered: { type: String, default: "0" }, // what the merchant's address was seen to receive
  amount_refunded: { type: String, default: "0" },
  refund_reason: { type: String, default: "" },
  destination_txids: { type: [String], default: [] }, // the provider's delivery transactions
  version: { type: Number, default: 0 }, // counts status changes; each is one webhook
  notified_version: { type: Number, default: 0 },
  quote_response: { type: Schema.Types.Mixed, default: null, select: false }, // the provider's signed quote, for disputes
};

// One payout of money that reached the deposit outside the merchant payout:
// partial money at expiry, or money after a cancel, expiry or completion (see
// "Refund routing" in docs/domain.md). Routes are numbered from 1, run one at
// a time, and each keeps its own checkpoint.
const refundRouteSchema = new Schema(
  {
    n: { type: Number, required: true },
    destination: { type: String, required: true },
    source: { type: String, enum: ["refund_address", "payout_address", "swap_to_receive_coin"], required: true },
    // swapping: the deposit reached the swap provider; paid: delivered (a swap
    // route) or proven on chain; refunded: the provider sent it back.
    state: { type: String, enum: ["processing", "swapping", "paid", "refunded", "failed"], required: true },
    raw: { type: String, default: "", select: false }, // the adapter's saved checkpoint (PayoutCheckpoint.state)
    swept: { type: String, default: "0" }, // what left the deposit: destination + platform fee + network cost
    platform_fee: { type: String, default: "0" },
    network_fee: { type: String, default: "0" },
    started_at: { type: Number, required: true },
    settled_at: { type: Number, default: null },
    notified: { type: Boolean, default: false }, // announced by webhook; see src/webhooks/webhook-pass.ts
    swap: { type: new Schema(swapFields, { _id: false }), default: null }, // source swap_to_receive_coin only
  },
  { _id: false },
);

// The rates the coin amount was worked out with, locked when the coin was
// chosen (see LockedRate in src/invoice/pricing.ts). Times are unix ms.
const lockedRateSchema = new Schema(
  {
    locked_at: { type: Number, required: true },
    coin_price_usd: { type: String, default: null },
    coin_price_usd_at: { type: Number, default: null },
    fiat_per_usd: { type: String, default: null },
    fiat_per_usd_at: { type: Number, default: null },
    price_asset_price_usd: { type: String, default: null },
    price_asset_price_usd_at: { type: Number, default: null },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    invoice_id: { type: String, required: true },
    user_id: { type: String, required: true },
    invoiceType: { type: String, default: "" },
    mode: { type: String, enum: ["fixed", "merchant_list", "swap"], default: "fixed" }, // fixed: merchant picked the coin; merchant_list: the payer picks one of offered_coins; swap: the payer picks one of offered_coins and it is swapped into to_crypto
    offered_coins: { type: [String], default: [] }, // merchant_list: coins the payer may pick
    status: { type: String, enum: INVOICE_STATUSES, default: "" }, // waiting, underpaid, confirming, confirmed, processing, completed, failed, expired, cancelled
    lifetime: { type: Number, default: 0 }, // lifetime in minutes within 1-60 minutes, default: 30
    underpaid: { type: Number, default: 0 }, // Allowed underpayment percentage before invoice is considered unpaid, default: 0
    fee_paid_by_payer: { type: Boolean, default: false }, // false = merchant covers transaction + platform fees, true = payer covers transaction + platform fees, default = false
    currency: { type: String, default: "usd" }, // invoice currency: the price unit, a fiat code (src/storage/currencies.ts) or an asset id
    amount: { type: String, required: true }, // invoice amount
    asked_amount: { type: String, default: "" }, // what the payer is asked to send: amount, plus the fees in payer-pays mode; see askedAmount()
    amount_fiat: { type: String, required: true }, // invoice amount in the invoice currency, in its smallest units (cents; satoshi for a BTC price)
    locked_rate: { type: lockedRateSchema, default: null }, // null until the coin is chosen
    paid_amount: { type: String, default: "0" }, // amount payer paid
    paid_amount_fiat: { type: Number, default: 0 }, // amount payer paid in the invoice currency
    remainder_amount: { type: Number, default: 0 }, // amount payer must pay for invoice to be confirmed
    remainder_amount_fiat: { type: Number, default: 0 }, // amount payer must pay for invoice to be confirmed in the invoice currency
    received_amount: { type: String, default: "0" }, // amount sent to merchant after all fees
    received_amount_fiat: { type: String, default: null }, // amount sent to merchant after all fees in the invoice currency
    network_fee: { type: String, default: "0" }, // fee to transfer the received asset to the merchant
    platform_fee: { type: String, default: "0" }, // fee charged by the platform, based on user's merchant fee
    fee_rate: { type: String, default: "" }, // the merchant's fee rate when the invoice was made; "" on older invoices, which use the merchant's current rate
    swap_max_loss_bps: { type: Number, default: null }, // the merchant's swap max loss when the invoice was made; null on older invoices, which use the merchant's current one
    swap_quoted_at: { type: Number, default: null }, // unix ms of the last swap quote for the merchant payout; quotes are spaced out
    swap_fee: { type: Number, default: 0 }, // written only by the removed legacy swap code; nothing reads it
    review_reason: { type: String, default: "" },
    notified_status: { type: String, default: "" }, // last status announced by webhook; see src/webhooks/webhook-pass.ts
    status_log: { type: [statusChangeSchema], default: [] }, // empty on invoices made before it existed
    notified_status_log: { type: Number, default: 0 }, // how many status_log entries the webhook pass has announced
    status_event_count: { type: Number, default: 0 }, // status events numbered so far; numbers the event ids
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
    return_url: { type: String, default: "" }, // offered to the payer once they are done paying or the invoice ended unpaid; see src/invoice/return-url.ts
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
      ...swapFields,
      origin_txids: { type: [String], default: [] },
      refunded_amount: { type: String, default: "0" }, // written only by the removed legacy swap code; see amount_refunded
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
