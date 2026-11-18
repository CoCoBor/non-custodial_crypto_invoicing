import { checkPayoutAddress } from "../assets/payout-address.js";
import { generateBtcAddress } from "../crypto/btc.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { estimateBtcPayoutNetworkCost, payOutBtc } from "../transactions/btc.js";
import type { ChainAdapter } from "./adapter.js";
import { getBlockbookPayments, nowNodesBtcBlockbook, type BlockbookApi } from "./blockbook.js";

/** Native BTC, deposits on P2PKH addresses. */
export function createBtcAdapter(deps: { platformAddress: string; api?: BlockbookApi }): ChainAdapter {
  const api = deps.api ?? nowNodesBtcBlockbook;
  return {
    asset: "btc",
    requiredConfirmations: cryptos.btc.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress("btc", address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === "btc",
    newDeposit: async () => {
      const { address, encryptedPrivateKey } = generateBtcAddress();
      return { address, key: { kind: "sealed_key", sealed: encryptedPrivateKey } };
    },
    getPayments: (address) => getBlockbookPayments(api, address),
    estimateNetworkCost: () => estimateBtcPayoutNetworkCost(api),
    payout: (request) => payOutBtc(request, { platformAddress: deps.platformAddress, api }),
  };
}
