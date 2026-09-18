import { Exchange } from "../config/markets.js";
import { ExchangeTicker, getTickers } from "./sources.js";
import { calculateWeightedPrice } from "./weighted-price.js";

const MAX_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;

const volumeWindow: Record<Exchange, "24h" | null> = {
  bitstamp: null,
  bitfinex: null,
  xt: null,
  kraken: "24h",
  binance: "24h",
  mexc: "24h",
  bybit: "24h",
  okx: "24h",
  gate: "24h",
  kucoin: "24h",
  cryptocom: "24h",
  gemini: "24h",
};

export interface ReferencePrice {
  baseAsset: string;
  quoteAsset: string;
  price: string;
  calculatedAtMs: number;
  tickers: ExchangeTicker[];
}

export async function getReferencePrice(
  baseAsset: string,
  quoteAsset: string,
): Promise<string | undefined> {
  const candidates = await getTickers(baseAsset, quoteAsset);

  const nowMs = Date.now();

  const fresh = (timestampMs: number) => {
    const ageMs = nowMs - timestampMs;
    return ageMs >= -MAX_FUTURE_SKEW_MS && ageMs <= MAX_AGE_MS;
  };

  const usableTickers = candidates.filter((ticker) => {
    volumeWindow[ticker.source] === "24h" &&
      fresh(ticker.receivedAtMs) &&
      (ticker.sourceTimestampMs === null || fresh(ticker.sourceTimestampMs));
  });

  const price = calculateWeightedPrice({
    tickers: usableTickers,
    priceDecimals: 36,
    volumeDecimals: 36,
    outputDecimals: 36,
  });

  if (price === undefined || price === "0") {
    return undefined;
  }

  return price;
}
