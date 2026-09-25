import bitcore from "bitcore-lib";
import { SealedSecret, sealSecret } from "../security/secret-envelope.js";
import { Invoice } from "../database/invoices.model.js";
import { env } from "../config/env.js";
import { z } from "zod";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { decimalStrToBigInt } from "./money.function.js";

export function generateBtcAddress(): {
  address: string;
  encryptedPrivateKey: SealedSecret;
} {
  const privateKey = new bitcore.PrivateKey();

  return {
    address: privateKey.toAddress().toString(),
    encryptedPrivateKey: sealSecret("bitcoin-deposit-key", privateKey.toWIF()),
  };
}

export async function findInvoiceById(invoiceId: string, userId: string) {
  return await Invoice.findOne({
    invoice_id: invoiceId,
    user_id: userId,
  })
    .select("-private")
    .lean()
    .exec();
}

const btcPaymentsSchema = z
  .object({
    totalPages: z.number().int().nonnegative(),
    txs: z.number().int().nonnegative(),
    unconfirmedTxs: z.number().int().nonnegative(),

    transactions: z
      .array(
        z.object({
          txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
          confirmations: z.number().int().nonnegative(),

          vout: z.array(
            z.object({
              value: z.string().regex(/^[0-9]+$/),
              isAddress: z.boolean().optional(),
              addresses: z.array(z.string()).optional(),
            }),
          ),
        }),
      )
      .default([]),
  })
  .refine(
    (data) =>
      data.transactions.length > 0 ||
      (data.txs === 0 && data.unconfirmedTxs === 0),
    {
      message: "Transaction details are missing",
    },
  );

export async function getBtcPayments(
  address: string,
): Promise<
  { txid: string; amount: bigint; confirmations: number }[] | undefined
> {
  const payments: {
    txid: string;
    amount: bigint;
    confirmations: number;
  }[] = [];

  const seenTxids = new Set<string>();
  let page = 1;

  try {
    while (true) {
      const url =
        `https://btcbook.nownodes.io/api/v2/address/` +
        `${encodeURIComponent(address)}` +
        `?details=txs&page=${page}&pageSize=100`;
      const res = await fetch(url, {
        headers: {
          "api-key": env.nowNodesApiKey,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.error("Failed to fetch BTC payments", res.status);
        return undefined;
      }

      const parsed = btcPaymentsSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.error("Invalid BTC payment response");
        return undefined;
      }

      const data = parsed.data;
      const transactions = data.transactions;

      for (const transaction of transactions) {
        if (seenTxids.has(transaction.txid)) {
          continue;
        }

        seenTxids.add(transaction.txid);

        let receivedAmount = 0n;

        for (const output of transaction.vout) {
          if (output.isAddress && output.addresses?.includes(address)) {
            receivedAmount += BigInt(output.value);
          }
        }

        if (receivedAmount > 0n) {
          payments.push({
            txid: transaction.txid,
            amount: receivedAmount,
            confirmations: transaction.confirmations,
          });
        }
      }
      if (page >= data.totalPages) {
        break;
      }

      page += 1;
    }
    return payments;
  } catch (error) {
    console.log("Failed to fetch BTC payments", error);
    return undefined;
  }
}

export function calculatePaymentTotals(
  payments: {
    txid: string;
    amount: bigint;
    confirmations: number;
  }[],
  requiredConfirmations: number,
): { receivedAmount: bigint; confirmedAmount: bigint } {
  let receivedAmount = 0n;
  let confirmedAmount = 0n;

  for (const payment of payments) {
    receivedAmount += payment.amount;

    if (payment.confirmations >= requiredConfirmations) {
      confirmedAmount += payment.amount;
    }
  }

  return { receivedAmount, confirmedAmount };
}

export function getPaymentStatus(input: {
  requiredAmount: bigint;
  receivedAmount: bigint;
  confirmedAmount: bigint;
}): "waiting" | "underpaid" | "confirming" | "confirmed" {
  const { requiredAmount, receivedAmount, confirmedAmount } = input;
  if (confirmedAmount >= requiredAmount) return "confirmed";
  if (receivedAmount >= requiredAmount) return "confirming";
  if (receivedAmount > 0n) return "underpaid";
  return "waiting";
}

export async function updateInvoicePayment(input: {
  invoiceId: string;
  currentStatus: "waiting" | "underpaid" | "confirming";
  newStatus: "waiting" | "underpaid" | "confirming" | "confirmed" | "expired";
  paidAmount: bigint;
}) {
  const { invoiceId, currentStatus, newStatus, paidAmount } = input;
  const changes: Record<string, string | number> = {
    paid_amount: paidAmount.toString(),
    status: newStatus,
  };

  if (
    newStatus !== currentStatus &&
    (newStatus == "confirmed" ||
      newStatus === "confirming" ||
      newStatus === "expired")
  ) {
    changes[`timestamps.${newStatus}`] = Date.now();
  }

  return await Invoice.updateOne(
    { invoice_id: invoiceId, crypto: "btc", status: currentStatus },
    { $set: changes },
  ).exec();
}

export async function checkInvoicePayment(
  invoiceId: string,
  userId: string,
): Promise<
  { invoiceId: string; status: string; paidAmount: string } | undefined
> {
  try {
    const invoice = await findInvoiceById(invoiceId, userId);

    if (!invoice || invoice.crypto !== "btc") return undefined;

    const currentStatus = invoice.status;

    if (
      currentStatus !== "waiting" &&
      currentStatus !== "underpaid" &&
      currentStatus !== "confirming"
    )
      return undefined;

    if (currentStatus !== "confirming") {
      const waitingSince = invoice.timestamps?.waiting;

      if (waitingSince == null) {
        console.error("Invoice waiting timestamp is missing");
        return undefined;
      }

      const expiresAt = waitingSince + invoice.lifetime * 60 * 1000;

      if (Date.now() >= expiresAt) {
        const result = await updateInvoicePayment({
          invoiceId,
          currentStatus,
          newStatus: "expired",
          paidAmount: BigInt(invoice.paid_amount),
          //if expired keep the paid_amount
        });
        if (result.modifiedCount === 0) return undefined;

        return {
          invoiceId,
          status: "expired",
          paidAmount: invoice.paid_amount,
        };
      }
    }

    const payments = await getBtcPayments(invoice.address);
    if (payments === undefined) return undefined;

    const totals = calculatePaymentTotals(
      payments,
      cryptos.btc.required_confirmations,
    );

    const newStatus = getPaymentStatus({
      requiredAmount: BigInt(invoice.amount),
      receivedAmount: totals.receivedAmount,
      confirmedAmount: totals.confirmedAmount,
    });

    const result = await updateInvoicePayment({
      invoiceId,
      currentStatus,
      newStatus,
      paidAmount: totals.receivedAmount,
    });
    if (result.matchedCount === 0) return undefined;

    return {
      invoiceId,
      status: newStatus,
      paidAmount: totals.receivedAmount.toString(),
    };
  } catch (error) {
    console.error("Failed to check invoice payment", error);
    return undefined;
  }
}
