import { findMarkets } from "../config/markets.js";
import { parseDecimalToScaledInteger } from "../money/decimal.js";
import { formatSmallestUnit } from "../money/format.js";

export interface MarketTicker {
  bid: string;
  ask: string;
  volume: string;
}

export interface WeightedPriceInput {
  tickers: MarketTicker[];
  priceDecimals: number;
  volumeDecimals: number;
  /** Defaults to priceDecimals; round once after weighting all inputs. */
  outputDecimals?: number;
}

export function calculateWeightedPrice(
  input: WeightedPriceInput,
): string | undefined {
  const { tickers, priceDecimals, volumeDecimals } = input;
  const outputDecimals = input.outputDecimals ?? priceDecimals;

  // Checked here rather than left to the parser: an empty ticker list never
  // runs the .map() below, so a bad scale would slip through unnoticed.
  if (
    !Number.isInteger(priceDecimals) ||
    priceDecimals < 0 ||
    priceDecimals > 36
  ) {
    throw new RangeError("priceDecimals must be an integer between 0 and 36");
  }

  if (
    !Number.isInteger(volumeDecimals) ||
    volumeDecimals < 0 ||
    volumeDecimals > 36
  ) {
    throw new RangeError("volumeDecimals must be an integer between 0 and 36");
  }

  if (!Number.isInteger(outputDecimals) || outputDecimals < 0 || outputDecimals > priceDecimals) {
    throw new RangeError("outputDecimals must be an integer between 0 and priceDecimals");
  }

  const parsed = tickers.map((ticker) => {
    const bid = parseDecimalToScaledInteger(ticker.bid, priceDecimals);
    const ask = parseDecimalToScaledInteger(ticker.ask, priceDecimals);
    const volume = parseDecimalToScaledInteger(ticker.volume, volumeDecimals);
    return { bid, ask, volume };
  });

  const validTickers = parsed.filter(
    (ticker): ticker is { bid: bigint; ask: bigint; volume: bigint } => {
      return (
        ticker.bid !== undefined &&
        ticker.ask !== undefined &&
        ticker.volume !== undefined &&
        ticker.bid > 0n &&
        ticker.ask > 0n &&
        ticker.volume > 0n
      );
    },
  );

  if (validTickers.length < 4) return undefined;

  let weightedSum = 0n;
  let totalVolume = 0n;

  for (const t of validTickers) {
    weightedSum += (t.bid + t.ask) * t.volume;
    totalVolume += t.volume;
  }

  const numerator = weightedSum;
  const denominator = 2n * totalVolume * 10n ** BigInt(priceDecimals - outputDecimals);

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  // Round half up: 2*remainder >= denominator means the dropped part is >= 0.5
  const roundedPrice = remainder * 2n >= denominator ? quotient + 1n : quotient;

  return formatSmallestUnit(roundedPrice, outputDecimals);
}