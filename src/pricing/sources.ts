import { z } from "zod";

import { parseDecimalToScaledInteger } from "../money/decimal.js";
import type { MarketTicker } from "./weighted-price.js";

interface Dependencies {
  fetcher?: typeof fetch;
  now?: () => number;
}

export interface ExchangeTicker extends MarketTicker {
  source: Exchange;
  baseAsset: string;
  quoteAsset: string;
  marketSymbol: string;
  sourceTimestampMs: number | null;
  receivedAtMs: number;
}

// Shared validation for the fields used by our calculation.
const decimal = z
  .string()
  .max(100)
  .regex(/^[0-9]+(?:\.[0-9]+)?$/);

const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestampString = z.string().max(16).regex(/^[0-9]+$/);
const statsSchema = z.object({
  symbol: z.string(), bidPrice: decimal, askPrice: decimal,
  volume: decimal, closeTime: milliseconds,
});

function sameMarket(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("unexpected market response");
}

// Expand JSON exponent notation without passing monetary values through Number.
function exactDecimal(token: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!match || token.length > 100) throw new Error("invalid numeric token");
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const shift = Number(exponent);
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 100) throw new Error("numeric exponent out of range");
  const digits = whole + fraction;
  const point = whole.length + shift;
  if (point <= 0) return sign + "0." + "0".repeat(-point) + digits;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return sign + digits.slice(0, point) + "." + digits.slice(point);
}

const tickerSchema = z.object({
  bid: decimal,
  ask: decimal,
  volume: decimal,
  sourceTimestampMs: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});

// Only the vendor-specific response structure belongs here.
const bitstampSchema = z.object({
  bid: decimal,
  ask: decimal,
  volume: decimal,
  timestamp: z.string().max(16).regex(/^[0-9]+$/),
  market_type: z.literal("SPOT"),
});

const krakenSchema = z.object({
  error: z.array(z.string()).length(0),
  result: z.record(
    z.string(),
    z.object({
      a: z.tuple([decimal, decimal, decimal]),
      b: z.tuple([decimal, decimal, decimal]),
      v: z.tuple([decimal, decimal]),
    }),
  ),
});

async function requestJson(
  url: string,
  fetcher: typeof fetch,
  preserveNumbers = false,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error("market request failed");
  }

  if (preserveNumbers) {
    // Node 22+ exposes the original JSON number token in the reviver context.
    // Fail closed on older runtimes instead of silently rounding prices.
    return JSON.parse(await response.text(), (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      if (context?.source === undefined) throw new Error("lossless JSON parsing requires Node 22+");
      return exactDecimal(context.source);
    });
  }
  return response.json();
}

type ReadSource = (
  symbol: string,
  fetcher: typeof fetch,
) => Promise<unknown>;

const sources: Record<Exchange, ReadSource> = {
  bitstamp: async (symbol, fetcher) => {
    const raw = await requestJson(
      `https://www.bitstamp.net/api/v2/ticker/${encodeURIComponent(symbol)}/`,
      fetcher,
    );

    const data = bitstampSchema.parse(raw);

    return {
      bid: data.bid,
      ask: data.ask,
      volume: data.volume,
      sourceTimestampMs: Number(data.timestamp) * 1000,
    };
  },

  kraken: async (symbol, fetcher) => {
    const raw = await requestJson(
      `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(symbol)}`,
      fetcher,
    );

    const { result } = krakenSchema.parse(raw);

    if (
      Object.keys(result).length !== 1 ||
      !Object.hasOwn(result, symbol)
    ) {
      throw new Error("unexpected market response");
    }

    const data = result[symbol];

    return {
      bid: data.b[0],
      ask: data.a[0],
      volume: data.v[1],
      sourceTimestampMs: null,
    };
  },
  binance: async (symbol, fetcher) => {
    const data = statsSchema.parse(await requestJson(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}&symbolStatus=TRADING`, fetcher,
    ));
    sameMarket(data.symbol, symbol);
    // closeTime is the statistics window end, not a bid/ask event time.
    return { bid: data.bidPrice, ask: data.askPrice, volume: data.volume, sourceTimestampMs: data.closeTime };
  },
  mexc: async (symbol, fetcher) => {
    const data = statsSchema.parse(await requestJson(
      `https://api.mexc.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, fetcher,
    ));
    sameMarket(data.symbol, symbol);
    return { bid: data.bidPrice, ask: data.askPrice, volume: data.volume, sourceTimestampMs: data.closeTime };
  },
  bybit: async (symbol, fetcher) => {
    const body = z.object({
      retCode: z.literal(0), time: milliseconds,
      result: z.object({ category: z.literal("spot"), list: z.array(z.object({
        symbol: z.string(), bid1Price: decimal, ask1Price: decimal, volume24h: decimal,
      })).length(1) }),
    }).parse(await requestJson(
      `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`, fetcher,
    ));
    const data = body.result.list[0];
    sameMarket(data.symbol, symbol);
    // Server response time: does not prove the underlying book changed recently.
    return { bid: data.bid1Price, ask: data.ask1Price, volume: data.volume24h, sourceTimestampMs: body.time };
  },
  okx: async (symbol, fetcher) => {
    const body = z.object({ code: z.literal("0"), data: z.array(z.object({
      instType: z.literal("SPOT"), instId: z.string(), bidPx: decimal, askPx: decimal,
      vol24h: decimal, ts: timestampString,
    })).length(1) }).parse(await requestJson(
      `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`, fetcher,
    ));
    const data = body.data[0];
    sameMarket(data.instId, symbol);
    return { bid: data.bidPx, ask: data.askPx, volume: data.vol24h, sourceTimestampMs: Number(data.ts) };
  },
  gate: async (symbol, fetcher) => {
    const [data] = z.array(z.object({
      currency_pair: z.string(), highest_bid: decimal, lowest_ask: decimal, base_volume: decimal,
    })).length(1).parse(await requestJson(
      `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(symbol)}`, fetcher,
    ));
    sameMarket(data.currency_pair, symbol);
    return { bid: data.highest_bid, ask: data.lowest_ask, volume: data.base_volume, sourceTimestampMs: null };
  },
  kucoin: async (symbol, fetcher) => {
    const { data } = z.object({ code: z.literal("200000"), data: z.object({
      symbol: z.string(), buy: decimal, sell: decimal, vol: decimal, time: milliseconds,
    }) }).parse(await requestJson(
      `https://api.kucoin.com/api/v1/market/stats?symbol=${encodeURIComponent(symbol)}`, fetcher,
    ));
    sameMarket(data.symbol, symbol);
    return { bid: data.buy, ask: data.sell, volume: data.vol, sourceTimestampMs: data.time };
  },
  cryptocom: async (symbol, fetcher) => {
    const body = z.object({ code: z.literal(0), result: z.object({ data: z.array(z.object({
      i: z.string(), b: decimal, k: decimal, v: decimal, t: milliseconds,
    })).length(1) }) }).parse(await requestJson(
      `https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=${encodeURIComponent(symbol)}`, fetcher,
    ));
    const data = body.result.data[0];
    sameMarket(data.i, symbol);
    // Crypto.com: k = best ask; a = last traded price, never use a here.
    return { bid: data.b, ask: data.k, volume: data.v, sourceTimestampMs: data.t };
  },
  xt: async (symbol, fetcher) => {
    const body = z.object({ rc: z.literal(0), result: z.array(z.object({
      s: z.string(), bp: decimal, ap: decimal, q: decimal, t: milliseconds,
    })).length(1) }).parse(await requestJson(
      `https://sapi.xt.com/v4/public/ticker?symbol=${encodeURIComponent(symbol)}`, fetcher,
    ));
    const data = body.result[0];
    sameMarket(data.s, symbol);
    // q is base volume; v is quote turnover.
    return { bid: data.bp, ask: data.ap, volume: data.q, sourceTimestampMs: data.t };
  },
  gemini: async (symbol, fetcher) => {
    const data = z.object({ bid: decimal, ask: decimal,
      volume: z.record(z.string(), z.unknown()),
    }).parse(await requestJson(
      `https://api.gemini.com/v1/pubticker/${encodeURIComponent(symbol)}`, fetcher,
    ));
    const base = symbol.replace(/(?:usdt|usd)$/, "").toUpperCase();
    // The timestamp belongs to volume statistics, not a bid/ask event.
    return { bid: data.bid, ask: data.ask, volume: decimal.parse(data.volume[base]),
      sourceTimestampMs: milliseconds.parse(data.volume.timestamp) };
  },
  bitfinex: async (symbol, fetcher) => {
    const [data] = z.array(z.tuple([
      z.string(), decimal, z.unknown(), decimal, z.unknown(), z.unknown(),
      z.unknown(), z.unknown(), decimal, z.unknown(), z.unknown(),
    ]).rest(z.unknown())).length(1).parse(await requestJson(
      `https://api-pub.bitfinex.com/v2/tickers?symbols=${encodeURIComponent(symbol)}`, fetcher, true,
    ));
    sameMarket(data[0], symbol);
    // Extra FIRST_TRADE field is not a ticker timestamp.
    return { bid: data[1], ask: data[3], volume: data[8], sourceTimestampMs: null };
  },
};

function validateTicker(
  raw: unknown,
  nowMs: number,
): z.infer<typeof tickerSchema> | undefined {
  const parsed = tickerSchema.safeParse(raw);

  if (!parsed.success) {
    return undefined;
  }

  const data = parsed.data;

  const bid = parseDecimalToScaledInteger(data.bid, 36);
  const ask = parseDecimalToScaledInteger(data.ask, 36);
  const volume = parseDecimalToScaledInteger(data.volume, 36);

  if (
    bid === undefined ||
    ask === undefined ||
    volume === undefined ||
    bid <= 0n ||
    ask <= 0n ||
    volume <= 0n ||
    bid > ask
  ) {
    return undefined;
  }

  if (data.sourceTimestampMs !== null) {
    const ageMs = nowMs - data.sourceTimestampMs;

    if (ageMs > 60_000 || ageMs < -5_000) {
      return undefined;
    }
  }

  return data;
}

export async function getTickers(
  baseAsset: string,
  quoteAsset: string,
  options: Dependencies = {},
): Promise<ExchangeTicker[]> {
  const configured = findMarkets(baseAsset, quoteAsset);

  if (configured === undefined) {
    return [];
  }

  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;

  // Build typed jobs without casting Object.entries() keys.
  const jobs: Array<{
    source: Exchange;
    symbol: string;
    read: ReadSource;
  }> = [];

  function add(source: Exchange) {
    const symbol = configured?.[source];

    if (symbol !== undefined) {
      jobs.push({ source, symbol, read: sources[source] });
    }
  }

  add("bitstamp");
  add("kraken");
  add("binance");
  add("mexc");
  add("bybit");
  add("okx");
  add("gate");
  add("kucoin");
  add("cryptocom");
  add("xt");
  add("gemini");
  add("bitfinex");


  const results = await Promise.allSettled(
    jobs.map(async ({ source, symbol, read }) => {
      const raw = await read(symbol, fetcher);
      const receivedAtMs = now();

      if (
        !Number.isSafeInteger(receivedAtMs) ||
        receivedAtMs < 0
      ) {
        throw new RangeError("invalid application clock");
      }

      const ticker = validateTicker(raw, receivedAtMs);

      if (ticker === undefined) {
        return undefined;
      }

      return {
        ...ticker,
        source,
        baseAsset,
        quoteAsset,
        marketSymbol: symbol,
        receivedAtMs,
      };
    }),
  );

  const tickers: ExchangeTicker[] = [];

  for (const result of results) {
    if (
      result.status === "fulfilled" &&
      result.value !== undefined
    ) {
      tickers.push(result.value);
    }
  }

  return tickers;
}
