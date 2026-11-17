import { checkPayoutAddress } from "../assets/payout-address.js";
import { generateLtcAddress } from "../crypto/ltc.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { estimateLtcPayoutNetworkCost, payOutLtc } from "../transactions/ltc.js";
import type { ChainAdapter } from "./adapter.js";
import { getBlockbookPayments, nowNodesLtcBlockbook, type BlockbookApi } from "./blockbook.js";

/** Native LTC, deposits on P2PKH (L...) addresses. */
export function createLtcAdapter(deps: { platformAddress: string; api?: BlockbookApi }): ChainAdapter {
  const api = deps.api ?? nowNodesLtcBlockbook;
  return {
    asset: "ltc",
    requiredConfirmations: cryptos.ltc.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress("ltc", address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === "ltc",
    newDeposit: async () => {
      const { address, encryptedPrivateKey } = generateLtcAddress();
      return { address, key: { kind: "sealed_key", sealed: encryptedPrivateKey } };
    },
    getPayments: (address) => getBlockbookPayments(api, address),
    estimateNetworkCost: () => estimateLtcPayoutNetworkCost(api),
    payout: (request) => payOutLtc(request, { platformAddress: deps.platformAddress, api }),
  };
}
