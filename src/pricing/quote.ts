import { parseDecimalToScaledInteger } from "../money/decimal.js";

export const PRICE_EXTRA_SCALE = 8;

export interface QuoteInput {
  fiatAmount: string; 
  currencyDecimals: number;
  price: string;
  cryptoDecimals: number;
}

export interface Quote {
  amountSmallestUnit: number;
  amountFiatMinorUnits: number;
}

export function quoteFromFiat(input: QuoteInput): Quote | undefined {
  const { fiatAmount, currencyDecimals, price, cryptoDecimals } = input;

  if (
    !Number.isInteger(currencyDecimals) ||
    currencyDecimals < 0 ||
    currencyDecimals > 18
  ) {
    throw new RangeError(
      "currencyDecimals must be an integer between 0 and 18",
    );
  }

  if (
    !Number.isInteger(cryptoDecimals) ||
    cryptoDecimals < 0 ||
    cryptoDecimals > 36
  ) {
    throw new RangeError("cryptoDecimals must be an integer between 0 and 36");
  }

  // merchant input required 50usd = 5000cent
  const fiatMinorUnits = parseDecimalToScaledInteger(
    fiatAmount,
    currencyDecimals,
  );

  const scaledPrice = parseDecimalToScaledInteger(
    price,
    currencyDecimals + PRICE_EXTRA_SCALE,
  );

  if (
    fiatMinorUnits === undefined ||
    scaledPrice === undefined ||
    fiatMinorUnits <= 0n ||
    scaledPrice <= 0n
  )
    return undefined;

  const priceScaleMultiplier = 10n ** BigInt(PRICE_EXTRA_SCALE);
  const smallestUnitsPerCoin = 10n ** BigInt(cryptoDecimals);

  const scaleFiat = fiatMinorUnits * priceScaleMultiplier;

  const numerator = scaleFiat * smallestUnitsPerCoin;

  // Math.ceil ceiling divisoin a/b = (a+b-1)/b
  const amountSmallestUnit = (numerator + scaledPrice - 1n) / scaledPrice;

  const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  if (amountSmallestUnit > maxSafeInteger || fiatMinorUnits > maxSafeInteger)
    return undefined;

  return {
    amountSmallestUnit: Number(amountSmallestUnit),
    amountFiatMinorUnits: Number(fiatMinorUnits),
  };
}
