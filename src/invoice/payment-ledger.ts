// Which payout carried which payment. A payout sweeps the whole deposit (BTC
// spends every confirmed output, TON sends the whole balance), so it carries
// whatever was on chain when it was built, not a list the watcher picked.
// See "Refund routing" in docs/domain.md.

/** A payment as the invoice records it. Amounts are integer strings in smallest units. */
export type LedgerPayment = {
  txid: string;
  amount: string;
  first_seen_at: number;
  confirmations: number;
  on_time: boolean;
  /** 0 = the merchant payout, n = refund route n; absent while still at the deposit. */
  payout?: number | null;
};

/** A proven payout and what it took from the deposit. */
export type Sweep = { payout: number; swept: bigint };

const isAtDeposit = (p: LedgerPayment) => p.payout === undefined || p.payout === null;

/**
 * Gives each payment still at the deposit to the proven payout that swept it.
 *
 * Payouts are taken oldest first. Each takes payments in the order the chain
 * received them (most confirmations first, then first seen) while what it
 * swept is not yet used up. A payment that only partly fits is still its:
 * the deposit can hold a little less than it received (TON storage fee), and
 * a payout never takes half a payment. A payment with no confirmation can't
 * have been swept. An assignment, once made, never changes.
 */
export function assignPayments<T extends LedgerPayment>(payments: T[], sweeps: Sweep[]): T[] {
  const result = payments.map((p) => ({ ...p }));
  const candidates = result
    .filter((p) => isAtDeposit(p) && p.confirmations >= 1)
    .sort((a, b) => b.confirmations - a.confirmations || a.first_seen_at - b.first_seen_at);

  let next = 0;
  for (const sweep of [...sweeps].sort((a, b) => a.payout - b.payout)) {
    let used = result
      .filter((p) => p.payout === sweep.payout)
      .reduce((sum, p) => sum + BigInt(p.amount), 0n);
    while (next < candidates.length && used < sweep.swept) {
      const payment = candidates[next]!;
      payment.payout = sweep.payout;
      used += BigInt(payment.amount);
      next += 1;
    }
  }
  return result;
}

/** Payments still at the deposit with at least `confirmations`. */
export function readyToRoute<T extends LedgerPayment>(payments: T[], confirmations: number): T[] {
  return payments.filter((p) => isAtDeposit(p) && p.confirmations >= confirmations);
}

/** Payments no payout has carried yet, confirmed or not. */
export function stillAtDeposit<T extends LedgerPayment>(payments: T[]): T[] {
  return payments.filter(isAtDeposit);
}

export function totalOf(payments: { amount: string }[]): bigint {
  return payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);
}
