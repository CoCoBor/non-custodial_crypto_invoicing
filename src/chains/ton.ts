import { checkPayoutAddress, type AssetId } from "../assets/payout-address.js";
import { generateTonAddress } from "../crypto/ton.js";
import type { SealedSecret } from "../security/secret-envelope.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import type { PricePort } from "../transactions/evm.js";
import { estimateTonJettonNetworkCost, getTonJettonPayments, payOutTonJetton } from "../transactions/ton-jetton.js";
import {
  getTonPayments,
  nowNodesTonApi,
  payOutTon,
  TON_PAYOUT_FEE,
  type TonApi,
} from "../transactions/ton.js";
import type { ChainAdapter } from "./adapter.js";

const newDeposit: ChainAdapter["newDeposit"] = async () => {
  const { address, encryptedPrivateKey } = await generateTonAddress();
  return { address, key: { kind: "sealed_key", sealed: encryptedPrivateKey } };
};

/** GRAM (native TON). Every payout message is non-bounceable (ADR 0001). */
export function createTonAdapter(deps: { platformAddress: string; api?: TonApi }): ChainAdapter {
  const api = deps.api ?? nowNodesTonApi;
  return {
    asset: "ton",
    requiredConfirmations: cryptos.ton.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress("ton", address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === "ton",
    newDeposit,
    getPayments: (address) => getTonPayments(api, address),
    // Every TON payout charges exactly this budget as its network cost.
    estimateNetworkCost: async () => TON_PAYOUT_FEE,
    payout: (request) => payOutTon(request, { api, platformAddress: deps.platformAddress }),
  };
}

/**
 * One jetton (USDT on TON), from its `jetton_master` and decimals in
 * cryptos.json. The deposit is a fresh TON wallet, as for GRAM; the TON gas
 * wallet pays its payouts' TON, reimbursed in the jetton.
 */
export function createTonJettonAdapter(deps: {
  asset: AssetId;
  platformAddress: string;
  gasWalletKey: SealedSecret | undefined;
  getPrice: PricePort;
  api?: TonApi;
}): ChainAdapter {
  const facts = cryptos[deps.asset];
  if (!("jetton_master" in facts) || facts.chain.symbol !== "ton") {
    throw new Error(`${deps.asset} is not a TON jetton in cryptos.json`);
  }
  const api = deps.api ?? nowNodesTonApi;
  const jetton = { asset: deps.asset, master: facts.jetton_master, decimals: facts.decimal };
  const asset = deps.asset;
  return {
    asset,
    requiredConfirmations: facts.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress(asset, address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === asset,
    newDeposit,
    getPayments: (address) => getTonJettonPayments(api, jetton, address),
    estimateNetworkCost: () => estimateTonJettonNetworkCost({ jetton, getPrice: deps.getPrice }),
    payout: (request) =>
      payOutTonJetton(request, {
        api,
        jetton,
        platformAddress: deps.platformAddress,
        gasWalletKey: deps.gasWalletKey,
        getPrice: deps.getPrice,
      }),
  };
}
