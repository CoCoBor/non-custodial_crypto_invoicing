import { ASSET_IDS, isAssetId, type AssetId } from "../assets/payout-address.js";
import { env } from "../config/env.js";
import type { ChainAdapter, ChainRegistry } from "./adapter.js";
import { getPrice } from "../invoice/price.function.js";
import { createBtcAdapter } from "./btc.js";
import { createEvmNativeAdapter, createEvmTokenAdapter, type EvmClients } from "./evm.js";
import { nowNodesBscBlockbook, nowNodesEthBlockbook } from "./evm-payments.js";
import { nowNodesBscRpc, nowNodesEthRpc } from "./evm-rpc.js";
import { createLtcAdapter } from "./ltc.js";
import { createSolAdapter, createSplTokenAdapter } from "./sol.js";
import { nowNodesSolRpc } from "./solana-rpc.js";
import { createTonAdapter, createTonJettonAdapter } from "./ton.js";

const eth: EvmClients = { rpc: nowNodesEthRpc, index: nowNodesEthBlockbook };
const bsc: EvmClients = { rpc: nowNodesBscRpc, index: nowNodesBscBlockbook };
const ethToken = { ...eth, chain: "eth", platformAddress: env.platformEthAddress, gasWalletKey: env.ethGasWalletKey, getPrice } as const;
const sol = { rpc: nowNodesSolRpc, platformAddress: env.platformSolAddress } as const;
const solToken = { ...sol, gasWalletKey: env.solGasWalletKey, getPrice } as const;

// One line per deposit asset. A payer can be offered, and the watcher only
// follows, the assets listed here. The BEP-20 tokens (usdtbsc, usdcbsc,
// daibsc) are left out until their contracts are checked against an
// official source (docs/domain.md, "EVM token contracts").
export const chainAdapters: ChainRegistry = {
  btc: createBtcAdapter({ platformAddress: env.platformBtcAddress }),
  ltc: createLtcAdapter({ platformAddress: env.platformLtcAddress }),
  eth: createEvmNativeAdapter({ ...eth, chain: "eth", platformAddress: env.platformEthAddress }),
  usdteth: createEvmTokenAdapter({ ...ethToken, asset: "usdteth" }),
  usdceth: createEvmTokenAdapter({ ...ethToken, asset: "usdceth" }),
  daieth: createEvmTokenAdapter({ ...ethToken, asset: "daieth" }),
  bsc: createEvmNativeAdapter({ ...bsc, chain: "bsc", platformAddress: env.platformBscAddress }),
  sol: createSolAdapter(sol),
  usdtsol: createSplTokenAdapter({ ...solToken, asset: "usdtsol" }),
  usdcsol: createSplTokenAdapter({ ...solToken, asset: "usdcsol" }),
  ton: createTonAdapter({ platformAddress: env.platformTonAddress }),
  usdtton: createTonJettonAdapter({
    asset: "usdtton",
    platformAddress: env.platformTonAddress,
    gasWalletKey: env.tonGasWalletKey,
    getPrice,
  }),
};

export function depositAssets(registry: ChainRegistry = chainAdapters): AssetId[] {
  return ASSET_IDS.filter((asset) => registry[asset] !== undefined);
}

export function adapterFor(
  asset: string,
  registry: ChainRegistry = chainAdapters,
): ChainAdapter | undefined {
  return isAssetId(asset) ? registry[asset] : undefined;
}
