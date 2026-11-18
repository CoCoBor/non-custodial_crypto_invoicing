import type { AppDeps } from "../app.js";
import { isAssetId, type AssetId } from "../assets/payout-address.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import { FIAT_CURRENCIES, isFiatCode, type FiatCode } from "../storage/currencies.js";
import { ceilDivide } from "../money/format.js";
import { isFreshFxRate } from "./fx-rates.js";
import { decimalStrToBigInt, intToDecimalStr } from "./money.function.js";

/** What an invoice is priced in: a fiat code or an asset id, lowercase. */
export type PriceUnit = FiatCode | AssetId;

/** The rates an invoice's coin amount was worked out with, as stored. */
export type LockedRate = {
  locked_at: number;
  /** USD per whole deposit coin; null when the price asset is the coin. */
  coin_price_usd: string | null;
  coin_price_usd_at: number | null;
  /** Fiat units per USD: "1" (and no time) for USD; null for a crypto price. */
  fiat_per_usd: string | null;
  fiat_per_usd_at: number | null;
  /** USD per whole price asset, for a crypto price in another coin. */
  price_asset_price_usd: string | null;
  price_asset_price_usd_at: number | null;
};

export function parsePriceUnit(value: string | undefined): PriceUnit | undefined {
  const unit = (value ?? "usd").trim().toLowerCase();
  return isFiatCode(unit) || isAssetId(unit) ? unit : undefined;
}

function decimalsOf(unit: PriceUnit): number {
  return isFiatCode(unit) ? FIAT_CURRENCIES[unit] : cryptos[unit].decimal;
}

/** The price in the unit's smallest units (ISO 4217 minor units, or the asset's), exactly. */
export function parsePriceAmount(unit: PriceUnit, text: string): bigint | undefined {
  const units = decimalStrToBigInt(text, decimalsOf(unit));
  return units !== undefined && units > 0n ? units : undefined;
}

function exactDecimal(text: string): { units: bigint; scale: bigint } | undefined {
  const match = /^([0-9]+)(?:\.([0-9]{1,36}))?$/.exec(text.trim());
  if (!match) return undefined;
  const fraction = match[2] ?? "";
  const units = BigInt(match[1] + fraction);
  return units > 0n ? { units, scale: 10n ** BigInt(fraction.length) } : undefined;
}

/**
 * Locks the rate for paying `priceUnits` of `unit` in `coin`: price unit →
 * USD → coin, rounded up once at the end so the payer is never asked for
 * less than the price. "price_unavailable": a price or a fresh FX rate is
 * missing.
 */
export async function lockPrice(input: {
  unit: PriceUnit;
  priceUnits: bigint;
  coin: AssetId;
  getPrice: AppDeps["getPrice"];
  getUsdToFiat: AppDeps["getUsdToFiat"];
  now: number;
}): Promise<{ amount: bigint; rate: LockedRate } | "price_unavailable"> {
  const { unit, priceUnits, coin, now } = input;
  const rate: LockedRate = {
    locked_at: now,
    coin_price_usd: null,
    coin_price_usd_at: null,
    fiat_per_usd: null,
    fiat_per_usd_at: null,
    price_asset_price_usd: null,
    price_asset_price_usd_at: null,
  };

  if (unit === coin) return { amount: priceUnits, rate };

  const [coinPrice, unitRate] = await Promise.all([
    input.getPrice(coin, "usd"),
    isFiatCode(unit)
      ? unit === "usd"
        ? { rate: "1", at: null }
        : input.getUsdToFiat(unit)
      : input.getPrice(unit, "usd").then((price) => price && { rate: price, at: now }),
  ]);
  if (coinPrice === undefined || !unitRate) return "price_unavailable";
  if (unitRate.at !== null && isFiatCode(unit) && !isFreshFxRate({ rate: unitRate.rate, at: unitRate.at }, now)) {
    return "price_unavailable";
  }

  const coinUsd = exactDecimal(coinPrice);
  const unitValue = exactDecimal(unitRate.rate);
  if (!coinUsd || !unitValue) return "price_unavailable";

  rate.coin_price_usd = coinPrice;
  rate.coin_price_usd_at = now;
  // USD per price unit, as a fraction: 1 / (fiat per USD), or the asset's USD price.
  let usdPerUnit: { numerator: bigint; denominator: bigint };
  if (isFiatCode(unit)) {
    rate.fiat_per_usd = unitRate.rate;
    rate.fiat_per_usd_at = unitRate.at;
    usdPerUnit = { numerator: unitValue.scale, denominator: unitValue.units };
  } else {
    rate.price_asset_price_usd = unitRate.rate;
    rate.price_asset_price_usd_at = now;
    usdPerUnit = { numerator: unitValue.units, denominator: unitValue.scale };
  }

  const coinScale = 10n ** BigInt(cryptos[coin].decimal);
  const unitScale = 10n ** BigInt(decimalsOf(unit));
  const amount = ceilDivide(
    priceUnits * usdPerUnit.numerator * coinUsd.scale * coinScale,
    unitScale * usdPerUnit.denominator * coinUsd.units,
  );
  return { amount, rate };
}

/** The invoice's price as shown to the merchant, the payer and the webhook. */
export function priceView(invoice: { currency?: string | null; amount_fiat: string }) {
  const unit = parsePriceUnit(invoice.currency ?? undefined);
  const amount =
    unit !== undefined && /^[0-9]+$/.test(invoice.amount_fiat)
      ? intToDecimalStr(BigInt(invoice.amount_fiat), decimalsOf(unit))
      : invoice.amount_fiat;
  return { unit: unit ?? invoice.currency ?? "usd", amount };
}

/** The locked rate as shown; null until a coin is chosen, and on invoices made before rates were stored. */
export function lockedRateView(rate: Partial<LockedRate> | null | undefined) {
  if (!rate?.locked_at) return null;
  return {
    lockedAt: rate.locked_at,
    coinPriceUsd: rate.coin_price_usd ?? null,
    coinPriceUsdAt: rate.coin_price_usd_at ?? null,
    fiatPerUsd: rate.fiat_per_usd ?? null,
    fiatPerUsdAt: rate.fiat_per_usd_at ?? null,
    priceAssetPriceUsd: rate.price_asset_price_usd ?? null,
    priceAssetPriceUsdAt: rate.price_asset_price_usd_at ?? null,
  };
}
