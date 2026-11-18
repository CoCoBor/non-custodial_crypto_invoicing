import { checkPayoutAddress, type AssetId } from "../assets/payout-address.js";
import { generateTronAddress } from "../crypto/tron.js";
import type { SealedSecret } from "../security/secret-envelope.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { estimateTronTokenNetworkCost, getTronTokenPayments, payOutTronToken, type TronToken } from "../transactions/tron.js";
import type { ChainAdapter } from "./adapter.js";
import type { TronApi, TronTokenIndex } from "./tron-api.js";

/** One TRC-20 token (USDT). Its fees are burned TRX, sent from the TRX gas wallet. TRX itself is not a deposit asset. */
export function createTronTokenAdapter(deps: {
  asset: AssetId;
  api: TronApi;
  index: TronTokenIndex;
  platformAddress: string | undefined;
  gasWalletKey: SealedSecret | undefined;
  /** TRX priced in the token, as decimal text. */
  trxPrice: () => Promise<string | undefined>;
  /** Tests on a local node, where the real contract can't be placed, pass the test token's address. */
  contract?: string;
  txLifetimeMs?: number;
  lostMarginMs?: number;
}): ChainAdapter {
  const facts = cryptos[deps.asset];
  if (!("contract_address" in facts) || facts.chain.symbol !== "trx") {
    throw new Error(`${deps.asset} is not a token on Tron in cryptos.json`);
  }
  const token: TronToken = { asset: deps.asset, contract: deps.contract ?? facts.contract_address, decimals: facts.decimal };
  const asset = deps.asset;
  const payoutDeps = {
    api: deps.api,
    token,
    platformAddress: deps.platformAddress,
    gasWalletKey: deps.gasWalletKey,
    trxPrice: deps.trxPrice,
    ...(deps.txLifetimeMs !== undefined && { txLifetimeMs: deps.txLifetimeMs }),
    ...(deps.lostMarginMs !== undefined && { lostMarginMs: deps.lostMarginMs }),
  };
  return {
    asset,
    requiredConfirmations: facts.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress(asset, address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === asset,
    newDeposit: async () => {
      const { address, encryptedPrivateKey } = generateTronAddress();
      return { address, key: { kind: "sealed_key", sealed: encryptedPrivateKey } };
    },
    getPayments: (address) => getTronTokenPayments({ api: deps.api, index: deps.index, token }, address),
    estimateNetworkCost: () => estimateTronTokenNetworkCost(payoutDeps),
    payout: (request) => payOutTronToken(request, payoutDeps),
  };
}
