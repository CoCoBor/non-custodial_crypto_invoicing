import { ASSET_IDS, isAssetId, type AssetId } from "../assets/payout-address.js";
import { env } from "../config/env.js";
import type { ChainAdapter, ChainRegistry } from "./adapter.js";
import { getPrice, getTrxPrice } from "../invoice/price.function.js";
import { createBtcAdapter } from "./btc.js";
import { createEvmNativeAdapter, createEvmTokenAdapter, type EvmClients } from "./evm.js";
import { nowNodesBscBlockbook, nowNodesEthBlockbook } from "./evm-payments.js";
import { nowNodesBscRpc, nowNodesEthRpc } from "./evm-rpc.js";
import { createLtcAdapter } from "./ltc.js";
import { createSolAdapter, createSplTokenAdapter } from "./sol.js";
import { nowNodesSolRpc } from "./solana-rpc.js";
import { createTonAdapter, createTonJettonAdapter } from "./ton.js";
import { createMoneroRpc } from "./monero-rpc.js";
import { createTronTokenAdapter } from "./tron.js";
import { nowNodesTronApi, nowNodesTronIndex } from "./tron-api.js";
import { createXmrAdapter } from "./xmr.js";

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
  usdttrx: createTronTokenAdapter({
    asset: "usdttrx",
    api: nowNodesTronApi,
    index: nowNodesTronIndex,
    platformAddress: env.platformTrxAddress,
    gasWalletKey: env.trxGasWalletKey,
    trxPrice: () => getTrxPrice("usdt"),
  }),
  // Registered even without a wallet: XMR invoices are then refused with a
  // 503 and the payer is never shown a deposit.
  xmr: createXmrAdapter({
    wallet: env.moneroWalletRpcUrl === undefined
      ? undefined
      : createMoneroRpc({
          url: env.moneroWalletRpcUrl,
          label: "XMR wallet RPC",
          ...(env.moneroWalletRpcLogin !== undefined && { login: env.moneroWalletRpcLogin }),
        }),
    daemon: env.moneroDaemonRpcUrl === undefined
      ? undefined
      : createMoneroRpc({ url: env.moneroDaemonRpcUrl, label: "XMR daemon RPC", timeoutMs: 15_000 }),
    platformAddress: env.platformXmrAddress,
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
