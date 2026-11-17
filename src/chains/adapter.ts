import type { AssetId } from "../assets/payout-address.js";
import type { SealedSecret } from "../security/secret-envelope.js";

// The seam between the invoice lifecycle and one chain. The watcher reaches a
// chain only through a ChainAdapter found in the registry (registry.ts) by the
// invoice's deposit asset. The contract, with its rules and the checklist for
// a new chain, is in docs/domain.md ("Chain adapter contract").
//
// Money is always bigint in the asset's smallest unit.

/** How the backend controls a deposit address. */
export type DepositKey =
  | { kind: "sealed_key"; sealed: SealedSecret }
  | { kind: "subaddress"; index: number };

export type NewDeposit = { address: string; key: DepositKey };

/** One incoming payment to a deposit address, as the chain shows it now. */
export type ChainPayment = {
  txid: string;
  amount: bigint;
  confirmations: number;
  /** Unix ms the provider first saw it (mempool) or its block time; omitted when the provider gives none. */
  seenAt?: number;
};

export type TransferKind =
  | "gas_top_up"
  | "merchant_payout"
  | "platform_fee"
  | "refund_route"
  | "swap_deposit";

export type Transfer = {
  kind: TransferKind;
  to: string;
  amount: bigint;
  txid: string;
};

/** What a saved payout will send. */
export type PayoutPlan = {
  transfers: Transfer[];
  platformFee: bigint;
  networkCost: bigint;
  /** Legacy NEAR swap of a BTC or TON deposit (ticket 15 replaces it). */
  legacySwap?: { depositAddress: string; deadline: string; quote?: unknown };
};

export type PayoutCheckpoint = {
  /** Adapter-private, e.g. the signed transaction. Only the adapter that wrote it reads it. */
  state: string;
  plan: PayoutPlan;
};

export type PayoutRequest = {
  depositAddress: string;
  depositKey: DepositKey;
  /** Receives everything that is not platform fee or network cost. */
  destination: string;
  destinationKind: "merchant_payout" | "refund_route";
  /** The deposit's own asset, except for a legacy swap (see canPayOutAs). */
  receiveAsset: AssetId;
  /** The invoice's fee rate in FEE_RATE_SCALE units (src/money/payout-split.ts). */
  feeRate: bigint;
  /** Pay out only once the deposit holds at least this much. */
  minimumAmount: bigint;
  /** The last checkpoint this adapter saved for this payout, if any. */
  checkpoint: PayoutCheckpoint | undefined;
  /**
   * Must be awaited, and must return true, before anything is broadcast.
   * false: another run saved first; broadcast nothing and return pending.
   */
  saveCheckpoint: (next: PayoutCheckpoint) => Promise<boolean>;
};

export type PayoutResult =
  /** Proven by the chain: every transfer the payout made. */
  | { status: "paid"; transfers: Transfer[]; note?: string }
  /** Not finished; call again. `review` is a note for a person; retrying stays safe. */
  | { status: "pending"; reason: string; review?: string }
  /** Fees and network cost would take it all. Nothing was sent. */
  | { status: "too_small"; reason: string }
  /** Needs a person. `message` says where the money is and how to recover it. */
  | { status: "failed"; message: string; transfers: Transfer[] };

export type ChainAdapter = {
  /** The deposit asset this adapter serves: its registry key. */
  asset: AssetId;
  requiredConfirmations: number;
  /** The chain's rule from src/assets/payout-address.ts. */
  isValidAddress: (address: string) => boolean;
  /** Can a deposit be paid out as `receiveAsset`? Always true for `asset` itself. */
  canPayOutAs: (receiveAsset: AssetId) => boolean;
  newDeposit: () => Promise<NewDeposit>;
  /** Every incoming payment to `address`. undefined: the lookup failed (never [] for a failure). */
  getPayments: (address: string) => Promise<ChainPayment[] | undefined>;
  /** Expected network cost of paying out one payment. undefined: unavailable now. */
  estimateNetworkCost: () => Promise<bigint | undefined>;
  payout: (request: PayoutRequest) => Promise<PayoutResult>;
};

export type ChainRegistry = Partial<Record<AssetId, ChainAdapter>>;
