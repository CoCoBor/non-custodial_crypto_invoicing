import { Schema, model } from "mongoose";

export const WEBHOOK_EVENTS_COLLECTION = "webhook_events";

const webhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true },
    userId: { type: String, required: true },
    invoiceId: { type: String, required: true },
    status: { type: String, required: true },
    // The exact JSON body that is signed and sent, kept so retries send the same bytes.
    payload: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    deliveredAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  {
    collection: WEBHOOK_EVENTS_COLLECTION,
    autoCreate: false,
    autoIndex: false,
  },
);

webhookEventSchema.index({ eventId: 1 }, { unique: true });
webhookEventSchema.index({ deliveredAt: 1, failedAt: 1, nextAttemptAt: 1 });

export const WebhookEvent = model("WebhookEvent", webhookEventSchema);
