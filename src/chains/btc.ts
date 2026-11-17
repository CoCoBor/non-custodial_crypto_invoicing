import { checkPayoutAddress } from "../assets/payout-address.js";
import { generateBtcAddress } from "../crypto/btc.js";
import { getBtcPayments } from "../invoice/invoice.function.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import {
  canPayOutFromBtcDeposit,
  estimateBtcPayoutNetworkCost,
  payOutBtc,
} from "../transactions/btc.js";
import type { ChainAdapter } from "./adapter.js";

/** Native BTC, deposits on P2PKH addresses. */
export function createBtcAdapter(deps: { platformAddress: string }): ChainAdapter {
  return {
    asset: "btc",
    requiredConfirmations: cryptos.btc.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress("btc", address) === "valid",
    // A BTC deposit can also go to a NEAR swap (legacy; ticket 15 replaces it).
    canPayOutAs: canPayOutFromBtcDeposit,
    newDeposit: async () => {
      const { address, encryptedPrivateKey } = generateBtcAddress();
      return { address, key: { kind: "sealed_key", sealed: encryptedPrivateKey } };
    },
    getPayments: (address) => getBtcPayments(address),
    estimateNetworkCost: estimateBtcPayoutNetworkCost,
    payout: (request) => payOutBtc(request, deps),
  };
}
