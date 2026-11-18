import { checkPayoutAddress, type AssetId } from "../assets/payout-address.js";
import { generateSolAddress } from "../crypto/sol.js";
import type { SealedSecret } from "../security/secret-envelope.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import type { PricePort } from "../transactions/evm.js";
import { estimateSolNetworkCost, estimateSplNetworkCost, payOutSol, payOutSplToken } from "../transactions/sol.js";
import type { ChainAdapter } from "./adapter.js";
import { getSolanaPayments } from "./solana-payments.js";
import type { SolanaRpc } from "./solana-rpc.js";

// Solana: SOL, and each SPL token with its mint from cryptos.json. One
// deposit address takes all of them: a token payment lands in that wallet's
// associated token account, which the payer's wallet creates.

const newDeposit: ChainAdapter["newDeposit"] = async () => {
  const { address, encryptedPrivateKey } = await generateSolAddress();
  return { address, key: { kind: "sealed_key", sealed: encryptedPrivateKey } };
};

export function createSolAdapter(deps: { rpc: SolanaRpc; platformAddress: string | undefined }): ChainAdapter {
  const asset = "sol";
  return {
    asset,
    requiredConfirmations: cryptos[asset].required_confirmations,
    isValidAddress: (address) => checkPayoutAddress(asset, address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === asset,
    newDeposit,
    getPayments: (address) => getSolanaPayments(deps.rpc, address),
    estimateNetworkCost: () => estimateSolNetworkCost(deps.rpc),
    payout: (request) => payOutSol(request, deps),
  };
}

/** One SPL token. The SOL gas wallet pays its payouts' fee and rent. */
export function createSplTokenAdapter(deps: {
  rpc: SolanaRpc;
  asset: AssetId;
  platformAddress: string | undefined;
  gasWalletKey: SealedSecret | undefined;
  getPrice: PricePort;
}): ChainAdapter {
  const facts = cryptos[deps.asset];
  if (!("mint_address" in facts) || facts.chain.symbol !== "sol") {
    throw new Error(`${deps.asset} is not an SPL token in cryptos.json`);
  }
  const token = { asset: deps.asset, mint: facts.mint_address, decimals: facts.decimal };
  const asset = deps.asset;
  return {
    asset,
    requiredConfirmations: facts.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress(asset, address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === asset,
    newDeposit,
    getPayments: (address) => getSolanaPayments(deps.rpc, address, token),
    estimateNetworkCost: () => estimateSplNetworkCost({ rpc: deps.rpc, token, getPrice: deps.getPrice }),
    payout: (request) =>
      payOutSplToken(request, {
        rpc: deps.rpc,
        token,
        platformAddress: deps.platformAddress,
        gasWalletKey: deps.gasWalletKey,
        getPrice: deps.getPrice,
      }),
  };
}
