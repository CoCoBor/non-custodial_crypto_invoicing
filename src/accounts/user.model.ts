import { Schema, model, type InferSchemaType } from "mongoose";
import { number } from "zod";

export const USERS_COLLECTION = "users";

const sealedSecretSchema = new Schema(
  {
    keyVersion: { type: Number, required: true },
    initialisationVector: { type: Buffer, required: true },
    authenticationTag: { type: Buffer, required: true },
    ciphertext: { type: Buffer, required: true },
  },
  { _id: false },
);

export const userSchema = new Schema(
  {
    user_id: { type: String, default: "" },
    account_hash: { type: String, default: "" },
    account_number_cipher: {
      type: sealedSecretSchema,
      default: null,
      select: false,
    },
    recovery_public_key: {
      type: String,
      default: "",
    },
    member_since: { type: Number, default: null },
    totp_secret: { type: sealedSecretSchema, default: null, select: false },
    totp_pending_secret: {
      type: sealedSecretSchema,
      default: null,
      select: false,
    },
    totp_enabled: { type: Boolean, default: false },
    totp_last_used_step: { type: Number, default: null, select: false },
    merchant_key: { type: String, default: "" },
    merchant_fee: { type: Number, default: 0.005 },
    telegram_id: { type: Number },
    telegram_name: { type: String },
    invoices: [{ id: { type: String, default: "" } }],
    payout_addresses: {
      btc: { type: String, default: "" },
      ltc: { type: String, default: "" },
      sol: { type: String, default: "" },
      usdtsol: { type: String, default: "" },
      usdcsol: { type: String, default: "" },
      eth: { type: String, default: "" },
      usdteth: { type: String, default: "" },
      usdceth: { type: String, default: "" },
      daieth: { type: String, default: "" },
      bsc: { type: String, default: "" },
      usdtbsc: { type: String, default: "" },
      usdcbsc: { type: String, default: "" },
      xmr: { type: String, default: "" },
      ton: { type: String, default: "" },
    },
  },
  { collection: USERS_COLLECTION, autoCreate: false, autoIndex: false },
);

// Defaults remain compatible with v2. Only generated, non-empty credentials
// participate in uniqueness checks; allocation is enforced by MongoDB.
userSchema.index(
  { user_id: 1 },
  {
    unique: true,
    partialFilterExpression: { user_id: { $type: "string", $gt: "" } },
  },
);
userSchema.index(
  { account_hash: 1 },
  {
    unique: true,
    partialFilterExpression: { account_hash: { $type: "string", $gt: "" } },
  },
);
userSchema.index(
  { merchant_key: 1 },
  {
    unique: true,
    partialFilterExpression: { merchant_key: { $type: "string", $gt: "" } },
  },
);
userSchema.index(
  { recovery_public_key: 1 },
  {
    unique: true,
    partialFilterExpression: {
      recovery_public_key: { $type: "string", $gt: "" },
    },
  },
);
export type UserData = InferSchemaType<typeof userSchema>;
export const User = model("User", userSchema);
