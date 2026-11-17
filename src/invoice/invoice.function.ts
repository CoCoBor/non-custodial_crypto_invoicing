import { Invoice } from "../database/invoices.model.js";
import { env } from "../config/env.js";
import { z } from "zod";
import type { ChainPayment } from "../chains/adapter.js";

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
          // Unix seconds: the block's time, or for a mempool transaction the
          // time this Blockbook first saw it.
          blockTime: z.number().int().positive().optional(),

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
): Promise<ChainPayment[] | undefined> {
  const payments: ChainPayment[] = [];

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
            ...(transaction.blockTime !== undefined && { seenAt: transaction.blockTime * 1000 }),
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
