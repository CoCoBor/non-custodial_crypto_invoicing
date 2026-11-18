import { checkPayoutAddress } from "../assets/payout-address.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { estimateXmrNetworkCost, getXmrPayments, newXmrDeposit, payOutXmr, type XmrDeps } from "../transactions/xmr.js";
import type { ChainAdapter } from "./adapter.js";

/**
 * XMR: one platform wallet (our own monero-wallet-rpc), a subaddress per
 * invoice. Registered even without a wallet: deposits are then refused
 * (DepositUnavailableError) and payouts wait.
 */
export function createXmrAdapter(deps: XmrDeps): ChainAdapter {
  return {
    asset: "xmr",
    requiredConfirmations: cryptos.xmr.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress("xmr", address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === "xmr",
    newDeposit: () => newXmrDeposit(deps.wallet),
    getPayments: (address) => getXmrPayments(deps.wallet, address),
    estimateNetworkCost: () => estimateXmrNetworkCost(deps),
    payout: (request) => payOutXmr(request, deps),
  };
}
