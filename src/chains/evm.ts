import { checkPayoutAddress, type AssetId } from "../assets/payout-address.js";
import { generateEthAddress } from "../crypto/eth.js";
import type { SealedSecret } from "../security/secret-envelope.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import {
  estimateEvmNativeNetworkCost,
  estimateEvmTokenNetworkCost,
  payOutEvmNative,
  payOutEvmToken,
  type EvmChain,
  type PricePort,
} from "../transactions/evm.js";
import type { ChainAdapter } from "./adapter.js";
import type { BlockbookApi } from "./blockbook.js";
import type { EvmRpc } from "./evm-rpc.js";
import { getEvmPayments } from "./evm-payments.js";

// One adapter family for every EVM chain: the native coin, and each
// ERC-20/BEP-20 token with its contract from cryptos.json.

export const EVM_CHAINS = {
  eth: {
    label: "ETH",
    chainId: 1n,
    nativeAsset: "eth",
    maxGasPrice: 500_000_000_000n, // 500 gwei
    gasWalletPurpose: "ethereum-gas-wallet-key",
  },
  bsc: {
    label: "BSC",
    chainId: 56n,
    nativeAsset: "bsc",
    maxGasPrice: 100_000_000_000n, // 100 gwei
    gasWalletPurpose: "bsc-gas-wallet-key",
  },
} as const satisfies Record<string, EvmChain>;

export type EvmChainName = keyof typeof EVM_CHAINS;

/** The two network clients: JSON-RPC for payouts, a Blockbook indexer for payment listings. */
export type EvmClients = { rpc: EvmRpc; index: BlockbookApi };

function newDeposit(): ChainAdapter["newDeposit"] {
  return async () => {
    const { address, encryptedPrivateKey } = generateEthAddress();
    return { address, key: { kind: "sealed_key", sealed: encryptedPrivateKey } };
  };
}

/** The chain's own coin: ETH on Ethereum, BNB (asset `bsc`) on BNB Smart Chain. */
export function createEvmNativeAdapter(deps: EvmClients & { chain: EvmChainName; platformAddress: string | undefined }): ChainAdapter {
  const chain = EVM_CHAINS[deps.chain];
  const asset = chain.nativeAsset;
  return {
    asset,
    requiredConfirmations: cryptos[asset].required_confirmations,
    isValidAddress: (address) => checkPayoutAddress(asset, address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === asset,
    newDeposit: newDeposit(),
    getPayments: (address) => getEvmPayments(deps.index, address),
    estimateNetworkCost: () => estimateEvmNativeNetworkCost({ chain, rpc: deps.rpc }),
    payout: (request) => payOutEvmNative(request, { chain, rpc: deps.rpc, platformAddress: deps.platformAddress }, asset),
  };
}

/** One ERC-20/BEP-20 token. Its gas is topped up from the chain's gas wallet. */
export function createEvmTokenAdapter(
  deps: EvmClients & {
    chain: EvmChainName;
    asset: AssetId;
    platformAddress: string | undefined;
    gasWalletKey: SealedSecret | undefined;
    getPrice: PricePort;
  },
): ChainAdapter {
  const chain = EVM_CHAINS[deps.chain];
  const facts = cryptos[deps.asset];
  if (!("contract_address" in facts) || facts.chain.symbol !== deps.chain) {
    throw new Error(`${deps.asset} is not a token on ${deps.chain} in cryptos.json`);
  }
  const token = { asset: deps.asset, contract: facts.contract_address, decimals: facts.decimal };
  const asset = deps.asset;
  return {
    asset,
    requiredConfirmations: facts.required_confirmations,
    isValidAddress: (address) => checkPayoutAddress(asset, address) === "valid",
    canPayOutAs: (receiveAsset) => receiveAsset === asset,
    newDeposit: newDeposit(),
    getPayments: (address) => getEvmPayments(deps.index, address, token.contract),
    estimateNetworkCost: () => estimateEvmTokenNetworkCost({ chain, rpc: deps.rpc, token, getPrice: deps.getPrice }),
    payout: (request) =>
      payOutEvmToken(request, {
        chain,
        rpc: deps.rpc,
        token,
        platformAddress: deps.platformAddress,
        gasWalletKey: deps.gasWalletKey,
        getPrice: deps.getPrice,
      }),
  };
}
