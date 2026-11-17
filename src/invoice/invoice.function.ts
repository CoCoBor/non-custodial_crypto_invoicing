import bitcore from "bitcore-lib";
import { SealedSecret, sealSecret } from "../security/secret-envelope.js";
import { Invoice } from "../database/invoices.model.js";
import { env } from "../config/env.js";
import { z } from "zod";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { decimalStrToBigInt } from "./money.function.js";
import { getTonPaymentTotals, tonMinimumPayment } from "../transactions/ton.js";

// Coins whose payments the watcher checks.
type WatchedCrypto = "btc" | "ton";

function asWatchedCrypto(value: string): WatchedCrypto | undefined {
  return value === "btc" || value === "ton" ? value : undefined;
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

// A deposit address sees a handful of payments. A listing longer than this is
// more likely a broken or hostile reply than a real history.
const MAX_BTC_PAGES = 50;

export async function getBtcPayments(
  address: string,
  { fetcher = fetch }: { fetcher?: typeof fetch } = {},
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
      const res = await fetcher(url, {
        headers: {
          "api-key": env.nowNodesApiKey,
          Accept: "application/json",
        },
        // A redirect would carry the api-key header to another host.
        redirect: "error",
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
      if (data.totalPages > MAX_BTC_PAGES) {
        console.error("BTC payment listing is implausibly long", data.totalPages);
        return undefined;
      }
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
  crypto: WatchedCrypto;
  currentStatus: "waiting" | "underpaid" | "confirming";
  newStatus: "waiting" | "underpaid" | "confirming" | "confirmed" | "expired";
  paidAmount: bigint;
}) {
  const { invoiceId, crypto, currentStatus, newStatus, paidAmount } = input;
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
    { invoice_id: invoiceId, crypto, status: currentStatus },
    { $set: changes },
  ).exec();
}

// undefined = lookup failed; try again next round.
async function getPaymentTotals(
  crypto: WatchedCrypto,
  address: string,
): Promise<{ receivedAmount: bigint; confirmedAmount: bigint } | undefined> {
  if (crypto === "ton") return await getTonPaymentTotals(address);

  const payments = await getBtcPayments(address);
  if (payments === undefined) return undefined;
  return calculatePaymentTotals(payments, cryptos.btc.required_confirmations);
}

export async function checkInvoicePayment(
  invoiceId: string,
  userId: string,
): Promise<
  { invoiceId: string; status: string; paidAmount: string } | undefined
> {
  try {
    const invoice = await findInvoiceById(invoiceId, userId);

    if (!invoice) return undefined;
    const crypto = asWatchedCrypto(invoice.crypto);
    if (crypto === undefined) return undefined;

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
          crypto,
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

    const totals = await getPaymentTotals(crypto, invoice.address);
    if (totals === undefined) return undefined;

    const invoiceAmount = BigInt(invoice.amount);
    const newStatus = getPaymentStatus({
      // TON: a payment in two parts can end a few nanoton short (storage
      // fee), so accept the same small shortfall the payout accepts. It
      // follows the invoice lifetime.
      requiredAmount:
        crypto === "ton"
          ? tonMinimumPayment(invoiceAmount, invoice.lifetime)
          : invoiceAmount,
      receivedAmount: totals.receivedAmount,
      confirmedAmount: totals.confirmedAmount,
    });

    const result = await updateInvoicePayment({
      invoiceId,
      crypto,
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
