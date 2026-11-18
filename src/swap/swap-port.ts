import type { AssetId } from "../assets/payout-address.js";

// The seam between the invoice lifecycle and a swap provider (spec: "Swap:
// quote, start and status"). Two providers implement it: NEAR Intents 1Click
// (src/swap/near.ts) and Exolix (src/swap/exolix.ts, XMR on either side).
// The app and the watcher use the router (src/swap/router.ts), itself a
// SwapPort, which picks the provider. Rules: docs/domain.md ("Swap mode").
//
// Money is bigint in each asset's smallest unit.

export type SwapProvider = "near_intents" | "exolix";

export type SwapRequest = {
  from: AssetId;
  to: AssetId;
  /** Exactly what will reach the provider's deposit address. */
  amountIn: bigint;
  /** The merchant's address for `to`. */
  recipient: string;
  /** Where the provider sends the coins back: the invoice's deposit address. */
  refundTo: string;
  /** The merchant's max loss, in basis points: the slippage tolerance. */
  maxLossBps: number;
};

export type SwapQuote = {
  provider: SwapProvider;
  /** The provider's own id for this swap, when it looks swaps up by id (Exolix). */
  swapId?: string;
  /** Send exactly `amountIn` of `from` here. */
  depositAddress: string;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  /** Unix ms. A deposit that arrives later is refunded. Undefined: the provider names none. */
  deadline?: number;
  /** The provider's whole reply, kept for disputes. */
  record: unknown;
};

export type QuoteAnswer =
  | { kind: "ok"; quote: SwapQuote }
  /** The provider's minimum is above what we can send. */
  | { kind: "too_small"; minimumIn?: bigint; reason: string }
  /** Not now (provider down, quote unusable); ask again later. */
  | { kind: "unavailable"; reason: string };

export const SWAP_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export type SwapStatusName = (typeof SWAP_STATUSES)[number];

/** Statuses after which the provider changes nothing more. */
export const FINAL_SWAP_STATUSES: readonly SwapStatusName[] = ["SUCCESS", "REFUNDED", "FAILED"];

export type SwapStatus = {
  status: SwapStatusName;
  amountIn?: bigint;
  amountOut?: bigint;
  refundedAmount?: bigint;
  refundReason?: string;
  /** The deposit transactions the provider saw. */
  originTxids: string[];
  /** The provider's transactions to the recipient. */
  deliveryTxids: string[];
};

/** Which swap a status or start call is about, as stored with it. */
export type SwapRef = {
  /** The stored provider. Swaps saved before ticket 24 may have "": NEAR's. */
  provider: string;
  depositAddress: string;
  /** The quote's `swapId`, for a provider that looks swaps up by id. */
  swapId?: string;
};

export type SwapPort = {
  /** Can this provider swap `from` into `to`? No network call. */
  supports: (from: AssetId, to: AssetId) => boolean;
  /** A real quote: it opens a deposit address for exactly `amountIn`. */
  quote: (request: SwapRequest) => Promise<QuoteAnswer>;
  /** Tells the provider the deposit was sent (a hint that can speed it up). */
  start: (deposit: SwapRef & { txid: string }) => Promise<boolean>;
  /** undefined: the lookup failed; ask again later. */
  status: (swap: SwapRef) => Promise<SwapStatus | undefined>;
};
