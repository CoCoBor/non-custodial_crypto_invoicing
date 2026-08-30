import { InvoiceStatus } from "./invoice.model.js";

export interface ObservedPayment {
  confirmedSatoshi: number;
  pendingSatoshi: number;
}

export interface InvoiceOutcomeInput {
  amountSatoshi: number;
  underpaidTolerancePercent: number;
  expiresAt: Date;
  status: InvoiceStatus;
}

export type InvoiceOutcome =
  | { status: "waiting" }
  | { status: "confirming"; paidSatoshi: number }
  | { status: "underpaid"; paidSatoshi: number; remainingSatoshi: number }
  | { status: "confirmed"; paidSatoshi: number; overpaidSatoshi: number }
  | { status: "expired" };

export function decideInvoiceOutcome(
  invoice: InvoiceOutcomeInput,
  observed: ObservedPayment,
  now: Date = new Date(),
): InvoiceOutcome {
  const { amountSatoshi, underpaidTolerancePercent, expiresAt } = invoice;
  const { confirmedSatoshi, pendingSatoshi } = observed;

  const total = confirmedSatoshi + pendingSatoshi;
  const thershold =
    amountSatoshi -
    Math.floor((amountSatoshi * underpaidTolerancePercent) / 100);

  if (total >= thershold) {
    if (pendingSatoshi > 0) {
      return { status: "confirming", paidSatoshi: total };
    }
    return {
      status: "confirmed",
      paidSatoshi: total,
      overpaidSatoshi: Math.max(0, total - amountSatoshi),
    };
  }

  if (now >= expiresAt && pendingSatoshi === 0) {
    return { status: "expired" };
  }

  if (total > 0) {
    return {
      status: "underpaid",
      paidSatoshi: total,
      remainingSatoshi: thershold - total,
    };
  }

  return { status: "waiting" };
}
