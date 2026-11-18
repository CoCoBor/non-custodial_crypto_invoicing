import { isAddress } from "@solana/kit";
import { z } from "zod";

import { associatedTokenAccount, type SplToken } from "../transactions/sol.js";
import type { ChainPayment } from "./adapter.js";
import type { SolanaRpc } from "./solana-rpc.js";

// Incoming payments to a Solana deposit, one per transaction. SOL: what the
// deposit's own balance gained. A token: what the deposit's associated token
// account for that mint gained; that is where wallets send it, and the only
// account the payout spends from.
//
// Confirmations: 1 once the transaction is finalized (it can't roll back),
// else 0. With required_confirmations 1 in cryptos.json, the watcher waits
// for "finalized".

// More transactions than this at one address: the list may be incomplete.
const MAX_SIGNATURES = 100;

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/);
const u64Number = z.number().int().nonnegative();

const signaturesSchema = z.array(
  z.object({
    signature: base58,
    err: z.unknown(),
    blockTime: z.number().int().nullable().optional(),
    confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).nullable().optional(),
  }),
);

const tokenBalanceSchema = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: base58,
  owner: base58.optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^(?:0|[1-9][0-9]*)$/), decimals: z.number().int() }),
});

const transactionSchema = z.object({
  meta: z.object({
    err: z.unknown(),
    preBalances: z.array(u64Number),
    postBalances: z.array(u64Number),
    preTokenBalances: z.array(tokenBalanceSchema).nullable().optional(),
    postTokenBalances: z.array(tokenBalanceSchema).nullable().optional(),
  }),
  transaction: z.object({ message: z.object({ accountKeys: z.array(z.object({ pubkey: base58 })) }) }),
});
type ParsedTransaction = z.infer<typeof transactionSchema>;

/** Every incoming payment to `owner` (SOL), or to its token account for `token`. undefined: the lookup failed or may be incomplete. */
export async function getSolanaPayments(rpc: SolanaRpc, owner: string, token?: SplToken): Promise<ChainPayment[] | undefined> {
  if (!isAddress(owner)) return undefined;
  const watched = token === undefined ? owner : await associatedTokenAccount(owner, token.mint);

  const listed = signaturesSchema.safeParse(
    await rpc.call("getSignaturesForAddress", [watched, { limit: MAX_SIGNATURES, commitment: "confirmed" }]),
  );
  if (!listed.success) return undefined;
  if (listed.data.length >= MAX_SIGNATURES) {
    console.warn("SOL address has too many transactions to list:", watched);
    return undefined;
  }

  const payments: ChainPayment[] = [];
  // Newest first from the node; the watcher wants them oldest first.
  for (const entry of [...listed.data].reverse()) {
    if (entry.err !== null && entry.err !== undefined) continue;
    const parsed = transactionSchema.safeParse(
      await rpc.call("getTransaction", [
        entry.signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]),
    );
    if (!parsed.success) return undefined;
    if (parsed.data.meta.err !== null && parsed.data.meta.err !== undefined) continue;

    const amount = token === undefined ? lamportsGained(parsed.data, watched) : tokensGained(parsed.data, watched, owner, token);
    if (amount === undefined) return undefined;
    if (amount <= 0n) continue;
    payments.push({
      txid: entry.signature,
      amount,
      confirmations: entry.confirmationStatus === "finalized" ? 1 : 0,
      ...(typeof entry.blockTime === "number" && { seenAt: entry.blockTime * 1000 }),
    });
  }
  return payments;
}

function lamportsGained(tx: ParsedTransaction, account: string): bigint | undefined {
  const index = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey === account);
  if (index < 0) return 0n;
  const before = tx.meta.preBalances[index];
  const after = tx.meta.postBalances[index];
  if (before === undefined || after === undefined) return undefined;
  return BigInt(after) - BigInt(before);
}

function tokensGained(tx: ParsedTransaction, account: string, owner: string, token: SplToken): bigint | undefined {
  const index = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey === account);
  if (index < 0) return 0n;
  const amountIn = (balances: ParsedTransaction["meta"]["preTokenBalances"]) => {
    let total = 0n;
    for (const balance of balances ?? []) {
      if (balance.accountIndex !== index || balance.mint !== token.mint) continue;
      if (balance.owner !== undefined && balance.owner !== owner) return undefined;
      if (balance.uiTokenAmount.decimals !== token.decimals) return undefined;
      total += BigInt(balance.uiTokenAmount.amount);
    }
    return total;
  };
  const before = amountIn(tx.meta.preTokenBalances);
  const after = amountIn(tx.meta.postTokenBalances);
  return before === undefined || after === undefined ? undefined : after - before;
}
