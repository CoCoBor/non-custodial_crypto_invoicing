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

/**
 * newDeposit can't make a deposit now (XMR: no platform wallet configured,
 * or it does not answer). Invoice creation answers 503 instead of crashing.
 */
export class DepositUnavailableError extends Error {
  constructor(
    readonly asset: AssetId,
    reason: string,
  ) {
    super(`${asset} deposits are unavailable: ${reason}`);
    this.name = "DepositUnavailableError";
  }
}

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
  /** swap_deposit: `destination` is a swap provider's deposit address (src/swap/swap-port.ts). */
  destinationKind: "merchant_payout" | "refund_route" | "swap_deposit";
  /** Always the deposit's own asset: another coin is reached through a swap. */
  receiveAsset: AssetId;
  /** The invoice's fee rate in FEE_RATE_SCALE units (src/money/payout-split.ts). */
  feeRate: bigint;
  /**
   * Money at the deposit that already paid its platform fee (a refunded
   * swap's money, routed again): the fee is charged only on the rest.
   * Omitted: 0. See splitPayout in src/money/payout-split.ts.
   */
  feeExempt?: bigint;
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
  /** Can a deposit be paid out as `receiveAsset`? True only for `asset` itself; other coins go through a swap. */
  canPayOutAs: (receiveAsset: AssetId) => boolean;
  newDeposit: () => Promise<NewDeposit>;
  /** Every incoming payment to `address`. undefined: the lookup failed (never [] for a failure). */
  getPayments: (address: string) => Promise<ChainPayment[] | undefined>;
  /**
   * Expected network cost of paying out one payment. undefined: unavailable
   * now. "unsupported": never available as configured (XMR without a daemon).
   */
  estimateNetworkCost: () => Promise<bigint | "unsupported" | undefined>;
  payout: (request: PayoutRequest) => Promise<PayoutResult>;
};

export type ChainRegistry = Partial<Record<AssetId, ChainAdapter>>;
