import bitcore from "bitcore-lib";
import { isAddress } from "ethers";

import { isValidTronAddress } from "../chains/tron-address.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { isValidLtcAddress } from "../transactions/ltc.js";
import { isValidSolAddress } from "../transactions/sol.js";
import { isValidTonAddress } from "../transactions/ton.js";

export type AssetId = keyof typeof cryptos;

export const ASSET_IDS = Object.keys(cryptos) as [AssetId, ...AssetId[]];

export function isAssetId(value: string): value is AssetId {
  return Object.hasOwn(cryptos, value);
}

function isValidBtcAddress(address: string): boolean {
  return bitcore.Address.isValid(address, bitcore.Networks.livenet);
}

// The zero address passes the format check, but nobody can spend from it.
function isValidEvmAddress(address: string): boolean {
  return isAddress(address) && BigInt(address) !== 0n;
}

// Keyed by chain: a token is paid out to an address of its chain's format.
// Chains missing here (Monero) have no payout code yet.
const addressRuleByChain: Partial<Record<string, (address: string) => boolean>> = {
  btc: isValidBtcAddress,
  ltc: isValidLtcAddress,
  eth: isValidEvmAddress,
  bsc: isValidEvmAddress,
  sol: isValidSolAddress,
  ton: isValidTonAddress,
  trx: isValidTronAddress,
};

export type PayoutAddressCheck = "valid" | "invalid" | "unsupported";

export function checkPayoutAddress(
  asset: AssetId,
  address: string | null | undefined,
): PayoutAddressCheck {
  const isValid = addressRuleByChain[cryptos[asset].chain.symbol];
  if (!isValid) return "unsupported";
  return address && isValid(address) ? "valid" : "invalid";
}
