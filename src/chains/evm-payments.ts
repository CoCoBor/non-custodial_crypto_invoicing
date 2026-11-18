import { z } from "zod";

import type { ChainPayment } from "./adapter.js";
import { createBlockbookApi, type BlockbookApi } from "./blockbook.js";

// Plain JSON-RPC has no "transactions of an address" call, and native coin
// transfers leave no log, so EVM payments are listed from a Blockbook
// indexer (NOWNodes in production). Token payments are its decoded Transfer
// logs (`tokenTransfers`), kept only for the token's own contract.
// Shapes: Blockbook's openapi.yaml (Tx, TokenTransfer, EthereumSpecific).

export const nowNodesEthBlockbook = createBlockbookApi({
  baseUrl: "https://eth-blockbook.nownodes.io/api/v2",
  label: "ETH",
});

export const nowNodesBscBlockbook = createBlockbookApi({
  baseUrl: "https://bsc-blockbook.nownodes.io/api/v2",
  label: "BSC",
});

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const units = z.string().regex(/^[0-9]+$/);

const pageSchema = z
  .object({
    totalPages: z.number().int().nonnegative().default(1),
    txs: z.number().int().nonnegative(),
    unconfirmedTxs: z.number().int().nonnegative().default(0),
    transactions: z
      .array(
        z.object({
          txid: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
          confirmations: z.number().int().nonnegative(),
          blockTime: z.number().int().positive().optional(),
          value: units.optional(),
          vout: z.array(z.object({ addresses: z.array(z.string()).optional() })).default([]),
          tokenTransfers: z
            .array(
              z.object({
                from: evmAddress,
                to: evmAddress,
                contract: evmAddress,
                standard: z.string().optional(),
                type: z.string().optional(),
                value: units.optional(),
              }),
            )
            .optional(),
          ethereumSpecific: z.object({
            // 1 success, 0 failed, -1 pending.
            status: z.number().int().min(-1).max(1),
            internalTransfers: z
              .array(z.object({ from: z.string(), to: z.string(), value: units.optional() }))
              .optional(),
          }),
        }),
      )
      .default([]),
  })
  .refine(
    (data) => data.transactions.length > 0 || (data.txs === 0 && data.unconfirmedTxs === 0),
    { message: "Transaction details are missing" },
  );

// A deposit address sees a handful of payments. A longer listing is more
// likely a broken or hostile reply than a real history.
const MAX_PAGES = 50;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Every transaction that paid `address`: in the native coin, or, with
 * `tokenContract`, in that token. undefined when any page fails, so a
 * partial list is never returned. A failed transaction pays nothing.
 */
export async function getEvmPayments(
  api: BlockbookApi,
  address: string,
  tokenContract?: string,
): Promise<ChainPayment[] | undefined> {
  const payments: ChainPayment[] = [];
  const seen = new Set<string>();

  for (let page = 1; ; page += 1) {
    const parsed = pageSchema.safeParse(
      await api.get(`/address/${encodeURIComponent(address)}?details=txs&page=${page}&pageSize=100`),
    );
    if (!parsed.success) return undefined;
    const data = parsed.data;
    if (data.totalPages > MAX_PAGES) {
      console.error("EVM payment listing is implausibly long", data.totalPages);
      return undefined;
    }

    for (const tx of data.transactions) {
      const txid = tx.txid.toLowerCase();
      // A new transaction can push older ones onto the next page.
      if (seen.has(txid)) continue;
      seen.add(txid);
      if (tx.ethereumSpecific.status === 0) continue;

      let amount = 0n;
      if (tokenContract === undefined) {
        if (tx.value !== undefined && tx.vout[0]?.addresses?.some((a) => same(a, address))) {
          amount += BigInt(tx.value);
        }
        // Coin sent to the deposit by a contract (e.g. an exchange's wallet).
        // Only present when the indexer records internal transfers.
        if (tx.ethereumSpecific.status === 1) {
          for (const internal of tx.ethereumSpecific.internalTransfers ?? []) {
            if (same(internal.to, address) && internal.value !== undefined) amount += BigInt(internal.value);
          }
        }
      } else {
        for (const transfer of tx.tokenTransfers ?? []) {
          const standard = transfer.standard ?? transfer.type;
          if (
            same(transfer.contract, tokenContract) &&
            same(transfer.to, address) &&
            (standard === "ERC20" || standard === "BEP20") &&
            transfer.value !== undefined
          ) {
            amount += BigInt(transfer.value);
          }
        }
      }

      if (amount > 0n) {
        payments.push({
          txid,
          amount,
          confirmations: tx.confirmations,
          ...(tx.blockTime !== undefined && { seenAt: tx.blockTime * 1000 }),
        });
      }
    }

    if (page >= data.totalPages) return payments;
  }
}
