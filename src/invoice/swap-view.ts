/** A swap record as stored on an invoice or a refund route. */
export type StoredSwapRecord = {
  provider?: string | null;
  deposit_address?: string | null;
  recipient?: string | null;
  receive_crypto?: string | null;
  status?: string | null;
  deadline?: string | null;
  amount_in?: string | null;
  min_amount_out?: string | null;
  amount_delivered?: string | null;
  amount_refunded?: string | null;
  refund_reason?: string | null;
  destination_txids?: string[] | null;
};

/**
 * The swap as the merchant sees it (status view and webhooks); null when there
 * is none. amountIn and amountRefunded are in the coin paid, the others in
 * the receive coin, all in smallest units.
 */
export function swapView(swap: StoredSwapRecord | null | undefined) {
  if (!swap?.deposit_address) return null;
  return {
    provider: swap.provider || "near_intents",
    depositAddress: swap.deposit_address,
    receiveCrypto: swap.receive_crypto ?? "",
    recipient: swap.recipient ?? "",
    status: swap.status ?? "",
    deadline: swap.deadline ?? "",
    amountIn: swap.amount_in ?? "0",
    minAmountOut: swap.min_amount_out ?? "",
    amountDelivered: swap.amount_delivered ?? "0",
    amountRefunded: swap.amount_refunded ?? "0",
    refundReason: swap.refund_reason ?? "",
    deliveryTxids: swap.destination_txids ?? [],
  };
}
