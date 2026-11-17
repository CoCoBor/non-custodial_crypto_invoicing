import { checkPayoutAddress } from "../assets/payout-address.js";
import { generateTonAddress } from "../crypto/ton.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import {
  getTonPayments,
  nowNodesTonApi,
  payOutTon,
  TON_PAYOUT_FEE,
  type TonApi,
} from "../transactions/ton.js";
import type { ChainAdapter } from "./adapter.js";

/** GRAM (native TON). Every payout message is non-bounceable (ADR 0001). */
export function createTonAdapter(deps: { platformAddress: string; api?: TonApi }): ChainAdapter {
  const api = deps.api ?? nowNodesTonApi;
  return {
    asset: "ton",
    requiredConfirmations: cryptos.ton.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress("ton", address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === "ton",
    newDeposit: async () => {
      const { address, encryptedPrivateKey } = await generateTonAddress();
      return { address, key: { kind: "sealed_key", sealed: encryptedPrivateKey } };
    },
    getPayments: (address) => getTonPayments(api, address),
    // Every TON payout charges exactly this budget as its network cost.
    estimateNetworkCost: async () => TON_PAYOUT_FEE,
    payout: (request) => payOutTon(request, { api, platformAddress: deps.platformAddress }),
  };
}
