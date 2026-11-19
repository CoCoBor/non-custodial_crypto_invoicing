import { z } from "zod";

import { decimalStrToBigInt, intToDecimalStr } from "./money.function.js";

import cryptos from "../storage/cryptos.json" with { type: "json" };
import marketConfig from "../storage/markets.json" with { type: "json" };
import { ceilDivide } from "../money/format.js";

const EXTRA_PRICE_DECIMALS = 8;
const CALCULATION_DECIMALS = 36;
const PRICE_DECIMALS = 10;
const MIN_SOURCES = 4;

// Owner decision 2026-11-20: a source whose midpoint is further than this from
// the leg's median midpoint is left out (docs/domain.md, Pricing).
const OUTLIER_LIMIT_BPS = { crypto: 250n, stablecoin: 100n } as const;

const MAX_AGE_MS = 60_000;
const MAX_FUTURE_MS = 5_000;

type CryptoId = keyof typeof cryptos;
type Currency = "usd" | "usdt";

const USD_STABLECOINS = new Set(
  Object.values(cryptos)
    .filter((asset) => "usd_stablecoin" in asset && asset.usd_stablecoin === true)
    .map((asset) => asset.symbol.toLowerCase()),
);

function outlierLimitBps(coin: string, currency: Currency): bigint {
  const quoteIsUsd = currency === "usd" || USD_STABLECOINS.has(currency);
  return USD_STABLECOINS.has(coin) && quoteIsUsd
    ? OUTLIER_LIMIT_BPS.stablecoin
    : OUTLIER_LIMIT_BPS.crypto;
}

/**
 * Calculates the payable amount in the coin's smallest unit from a fiat amount and unit price.
 * coinPrice must be quoted in the same currency as fiatAmount.
 */
export function getUsdToCrypto(input: {
  fiatAmount: string;
  fiatDecimals: number;
  coinPrice: string;
  coinDecimals: number;
}):
  | {
      paymentUnits: bigint;
      fiatUnits: bigint;
    }
  | undefined {
  const { fiatAmount, fiatDecimals, coinPrice, coinDecimals } = input;

  if (
    !Number.isInteger(fiatDecimals) ||
    fiatDecimals < 0 ||
    fiatDecimals > 18
  ) {
    throw new RangeError("fiatDecimals must be an integer from 0 to 18");
  }

  if (
    !Number.isInteger(coinDecimals) ||
    coinDecimals < 0 ||
    coinDecimals > 36
  ) {
    throw new RangeError("coinDecimals must be an integer from 0 to 36");
  }

  const fiatUnits = decimalStrToBigInt(fiatAmount, fiatDecimals);

  const priceDecimals = fiatDecimals + EXTRA_PRICE_DECIMALS;

  const priceInteger = decimalStrToBigInt(coinPrice, priceDecimals);

  if (
    fiatUnits === undefined ||
    priceInteger === undefined ||
    fiatUnits <= 0n ||
    priceInteger <= 0n
  ) {
    return undefined;
  }

  const extraPriceMultiplier = 10n ** BigInt(EXTRA_PRICE_DECIMALS);

  const amountAtPriceScale = fiatUnits * extraPriceMultiplier;

  const unitsPerCoin = 10n ** BigInt(coinDecimals);
  const numerator = amountAtPriceScale * unitsPerCoin;

  const paymentUnits = ceilDivide(numerator,priceInteger)
  
  return {
    paymentUnits,
    fiatUnits,
  };
}

// Each exchange only defines its URL and its own response fields.
// Amount format, positive values, and bid <= ask are checked once in getTicker.
const exchanges = {
  binance: {
    url: (market: string) =>
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(market)}`,

    schema: z
      .object({
        symbol: z.string(),
        bidPrice: z.string(),
        askPrice: z.string(),
        volume: z.string(),
        closeTime: z.number(),
      })
      .transform((data) => ({
        symbol: data.symbol,
        bid: data.bidPrice,
        ask: data.askPrice,
        volume: data.volume,
        timeMs: data.closeTime,
      })),
  },

  bybit: {
    url: (market: string) =>
      `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(market)}`,

    schema: z
      .object({
        retCode: z.literal(0),
        time: z.number(),
        result: z.object({
          category: z.literal("spot"),
          list: z
            .array(
              z.object({
                symbol: z.string(),
                bid1Price: z.string(),
                ask1Price: z.string(),
                volume24h: z.string(),
              }),
            )
            .length(1),
        }),
      })
      .transform((data) => ({
        symbol: data.result.list[0].symbol,
        bid: data.result.list[0].bid1Price,
        ask: data.result.list[0].ask1Price,
        volume: data.result.list[0].volume24h,
        timeMs: data.time,
      })),
  },

  okx: {
    url: (market: string) =>
      `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(market)}`,

    schema: z
      .object({
        code: z.literal("0"),
        data: z
          .array(
            z.object({
              instType: z.literal("SPOT"),
              instId: z.string(),
              bidPx: z.string(),
              askPx: z.string(),
              vol24h: z.string(),
              ts: z.string().regex(/^[0-9]+$/),
            }),
          )
          .length(1),
      })
      .transform(({ data }) => ({
        symbol: data[0].instId,
        bid: data[0].bidPx,
        ask: data[0].askPx,
        volume: data[0].vol24h,
        timeMs: Number(data[0].ts),
      })),
  },

  gate: {
    url: (market: string) =>
      `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(market)}`,

    schema: z
      .array(
        z.object({
          currency_pair: z.string(),
          highest_bid: z.string(),
          lowest_ask: z.string(),
          base_volume: z.string(),
        }),
      )
      .length(1)
      .transform(([data]) => ({
        symbol: data.currency_pair,
        bid: data.highest_bid,
        ask: data.lowest_ask,
        volume: data.base_volume,
        timeMs: null,
      })),
  },

  bitstamp: {
    url: (market: string) =>
      `https://www.bitstamp.net/api/v2/ticker/${encodeURIComponent(market)}/`,

    schema: z
      .object({
        bid: z.string(),
        ask: z.string(),
        volume: z.string(),
        timestamp: z.string().regex(/^[0-9]+$/),
        market_type: z.literal("SPOT"),
      })
      .transform((data) => ({
        // The response has no market name; the request URL sets the market.
        symbol: "",
        bid: data.bid,
        ask: data.ask,
        volume: data.volume,
        timeMs: Number(data.timestamp) * 1000,
      })),
  },

  kraken: {
    url: (market: string) =>
      `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(market)}`,

    schema: z
      .object({
        error: z.array(z.string()).length(0),
        result: z.record(
          z.string(),
          z.object({
            b: z.tuple([z.string()]).rest(z.unknown()),
            a: z.tuple([z.string()]).rest(z.unknown()),
            v: z.tuple([z.unknown(), z.string()]).rest(z.unknown()),
          }),
        ),
      })
      .refine((data) => Object.keys(data.result).length === 1)
      .transform((data) => {
        const [symbol, ticker] = Object.entries(data.result)[0];

        return {
          symbol,
          bid: ticker.b[0],
          ask: ticker.a[0],
          // v[0] is today; v[1] is the last 24 hours.
          volume: ticker.v[1],
          timeMs: null,
        };
      }),
  },

  mexc: {
    url: (market: string) =>
      `https://api.mexc.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(market)}`,

    schema: z
      .object({
        symbol: z.string(),
        bidPrice: z.string(),
        askPrice: z.string(),
        volume: z.string(),
        closeTime: z.number(),
      })
      .transform((data) => ({
        symbol: data.symbol,
        bid: data.bidPrice,
        ask: data.askPrice,
        volume: data.volume,
        timeMs: data.closeTime,
      })),
  },

  kucoin: {
    url: (market: string) =>
      `https://api.kucoin.com/api/v1/market/stats?symbol=${encodeURIComponent(market)}`,

    schema: z
      .object({
        code: z.literal("200000"),
        data: z.object({
          symbol: z.string(),
          buy: z.string(),
          sell: z.string(),
          vol: z.string(),
          time: z.number(),
        }),
      })
      .transform(({ data }) => ({
        symbol: data.symbol,
        bid: data.buy,
        ask: data.sell,
        volume: data.vol,
        timeMs: data.time,
      })),
  },

  cryptocom: {
    url: (market: string) =>
      `https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=${encodeURIComponent(market)}`,

    schema: z
      .object({
        code: z.literal(0),
        result: z.object({
          data: z
            .array(
              z.object({
                i: z.string(),
                b: z.string(),
                k: z.string(),
                v: z.string(),
                t: z.number(),
              }),
            )
            .length(1),
        }),
      })
      .transform(({ result }) => ({
        symbol: result.data[0].i,
        bid: result.data[0].b,
        // k is the ask; a is the last trade price.
        ask: result.data[0].k,
        volume: result.data[0].v,
        timeMs: result.data[0].t,
      })),
  },

  xt: {
    url: (market: string) =>
      `https://sapi.xt.com/v4/public/ticker?symbol=${encodeURIComponent(market)}`,

    schema: z
      .object({
        rc: z.literal(0),
        result: z
          .array(
            z.object({
              s: z.string(),
              bp: z.string(),
              ap: z.string(),
              q: z.string(),
              t: z.number(),
            }),
          )
          .length(1),
      })
      .transform(({ result }) => ({
        symbol: result[0].s,
        bid: result[0].bp,
        ask: result[0].ap,
        volume: result[0].q,
        timeMs: result[0].t,
      })),
  },

  gemini: {
    url: (market: string) =>
      `https://api.gemini.com/v1/pubticker/${encodeURIComponent(market)}`,

    schema: z
      .object({
        bid: z.string(),
        ask: z.string(),
        volume: z.record(z.string(), z.unknown()),
      })
      .transform((data) => ({
        symbol: "",
        bid: data.bid,
        ask: data.ask,
        // getTicker picks the right coin's volume based on the market.
        volume: "",
        timeMs: null,
        volumes: data.volume,
      })),
  },

  bitfinex: {
    url: (market: string) =>
      `https://api-pub.bitfinex.com/v2/tickers?symbols=${encodeURIComponent(market)}`,

    schema: z
      .array(
        z
          .tuple([
            z.string(), // 0: symbol
            z.string(), // 1: bid
            z.unknown(), // 2: bid size
            z.string(), // 3: ask
            z.unknown(), // 4: ask size
            z.unknown(), // 5: daily change
            z.unknown(), // 6: daily change percentage
            z.unknown(), // 7: last price
            z.string(), // 8: volume
          ])
          .rest(z.unknown()),
      )
      .length(1)
      .transform(([data]) => ({
        symbol: data[0],
        bid: data[1],
        ask: data[3],
        volume: data[8],
        timeMs: null,
      })),
  },

  htx: {
    url: (market: string) =>
      `https://api.huobi.pro/market/detail/merged?symbol=${encodeURIComponent(market)}`,

    schema: z
      .object({
        status: z.literal("ok"),
        ch: z.string().regex(/^market\.[a-z0-9]+\.detail\.merged$/),
        ts: z.string().regex(/^[0-9]+$/),
        tick: z.object({
          // [price, size]
          bid: z.tuple([z.string(), z.string()]),
          ask: z.tuple([z.string(), z.string()]),
          amount: z.string(),
        }),
      })
      .transform((data) => ({
        symbol: data.ch.split(".")[1],
        bid: data.tick.bid[0],
        ask: data.tick.ask[0],
        volume: data.tick.amount,
        timeMs: Number(data.ts),
      })),
  },
};

type Exchange = keyof typeof exchanges;

const exchangeNames = Object.keys(exchanges) as Exchange[];

const markets: Record<
  string,
  Partial<Record<Currency, Partial<Record<Exchange, string>>>>
> = marketConfig;

// Bitstamp can still be read on its own.
// Its volume window is not yet confirmed to match the other sources, so it is left out of weighting for now.
// XT and Bitfinex count for every coin (owner decision 2026-11-20): their
// volumes were checked to be rolling 24 h base-coin volumes, like the other
// weighted sources (docs/domain.md, Pricing).
const excludedFromWeighting = new Set<Exchange>(["bitstamp"]);

const tickerSchema = z.object({
  symbol: z.string(),
  bid: z.string(),
  ask: z.string(),
  volume: z.string(),
  timeMs: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});

type Ticker = {
  exchange: Exchange;
  bid: bigint;
  ask: bigint;
  volume: bigint;
  sourceTimeMs: number | null;
  receivedAtMs: number;
};

/**
 * Reads one exchange.
 * The returned bid, ask, and volume are bigints scaled up by 36 decimal places.
 * Returns undefined when the market is not configured, the request fails, or the data is invalid.
 */
export async function getTicker(
  exchange: Exchange,
  coin: string,
  currency: Currency = "usdt",
): Promise<Ticker | undefined> {
  const base = coin.toLowerCase();
  const market = markets[base]?.[currency]?.[exchange];

  if (!market) return undefined;

  const config = exchanges[exchange];

  try {
    const response = await fetch(config.url(market), {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return undefined;

    let raw: unknown;

    if (exchange === "bitfinex" || exchange === "htx") {
      // Node.js 24: keep the original text of JSON numbers to avoid Number rounding.
      raw = JSON.parse(
        await response.text(),
        (_key: string, value: unknown, context?: { source?: string }) => {
          if (typeof value !== "number") return value;

          if (!context?.source) {
            throw new Error("Original JSON number is unavailable");
          }

          return expandNumber(context.source);
        },
      );
    } else {
      raw = await response.json();
    }

    let candidate: z.infer<typeof tickerSchema>;

    if (exchange === "gemini") {
      // Use the Gemini schema explicitly so TypeScript knows the type of volumes.
      const parsed = exchanges.gemini.schema.safeParse(raw);

      if (!parsed.success) return undefined;

      const data = parsed.data;

      const volumeKey = market.slice(0, -currency.length).toUpperCase();

      const volume = z.string().parse(data.volumes[volumeKey]);

      const timestamp = z
        .union([z.number(), z.string().regex(/^[0-9]+$/)])
        .parse(data.volumes.timestamp);

      candidate = {
        symbol: data.symbol,
        bid: data.bid,
        ask: data.ask,
        volume,
        timeMs: Number(timestamp),
      };
    } else {
      const parsed = config.schema.safeParse(raw);

      if (!parsed.success) return undefined;

      candidate = parsed.data;
    }

    const checked = tickerSchema.safeParse(candidate);

    if (!checked.success) return undefined;

    const data = checked.data;

    // These two responses have no market name; every other source must match the configured market.
    if (
      exchange !== "bitstamp" &&
      exchange !== "gemini" &&
      data.symbol !== market
    ) {
      return undefined;
    }

    const bid = decimalStrToBigInt(data.bid, CALCULATION_DECIMALS);
    const ask = decimalStrToBigInt(data.ask, CALCULATION_DECIMALS);
    const volume = decimalStrToBigInt(data.volume, CALCULATION_DECIMALS);

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

    return {
      exchange,
      bid,
      ask,
      volume,
      sourceTimeMs: data.timeMs,
      receivedAtMs: Date.now(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Returns a weighted reference price across exchanges, as a string.
 * USD and USDT are calculated separately and never substitute for each other.
 * A USD price may still be crossed: the USDT price × the USDT/USD price.
 */
export async function getPrice(
  cryptoId: CryptoId,
  currency: Currency,
): Promise<string | undefined> {
  const asset = cryptos[cryptoId];

  if (!asset) return undefined;

  return await priceOfCoin(asset.symbol.toLowerCase(), currency);
}

/**
 * The price of TRX, which payers can't pay with (it is not in cryptos.json):
 * Tron USDT payouts burn it for their network fees.
 */
export async function getTrxPrice(currency: Currency): Promise<string | undefined> {
  return await priceOfCoin("trx", currency);
}

async function priceOfCoin(
  coin: string,
  currency: Currency,
): Promise<string | undefined> {
  // A same-asset unit conversion; it does not mean USDT equals USD.
  if (coin === currency) return "1";

  const direct = await weightedPrice(coin, currency, MIN_SOURCES);
  if (direct !== undefined || currency !== "usd") return direct;

  return (await priceThroughUsdt(coin)) ?? (await peggedPrice(coin));
}

// Many coins have fewer than MIN_SOURCES live USD markets but plenty of USDT
// ones. Each leg must still meet MIN_SOURCES on its own.
async function priceThroughUsdt(coin: string): Promise<string | undefined> {
  if (coin === "usdt") return undefined;

  const [inUsdt, usdtInUsd] = await Promise.all([
    weightedPrice(coin, "usdt", MIN_SOURCES),
    weightedPrice("usdt", "usd", MIN_SOURCES),
  ]);
  if (inUsdt === undefined || usdtInUsd === undefined) return undefined;

  const scale = 10n ** BigInt(PRICE_DECIMALS);
  const raw =
    decimalStrToBigInt(inUsdt, PRICE_DECIMALS)! *
    decimalStrToBigInt(usdtInUsd, PRICE_DECIMALS)!;
  const price = raw / scale + ((raw % scale) * 2n >= scale ? 1n : 0n);

  return price === 0n ? undefined : intToDecimalStr(price, PRICE_DECIMALS);
}

// DAI is delisted from most exchanges, so it can't meet MIN_SOURCES. Sky's
// LitePSM swaps DAI and USDC 1:1 with no fee (tin = tout = 0), so DAI takes
// USDC's price, while DAI's own remaining markets confirm the peg holds.
const PEGS: Record<string, { to: string; maxDeviationBps: bigint }> = {
  dai: { to: "usdc", maxDeviationBps: 100n },
};
const PEG_CHECK_MIN_SOURCES = 2;

async function peggedPrice(coin: string): Promise<string | undefined> {
  const peg = PEGS[coin];
  if (!peg) return undefined;

  const [anchor, own] = await Promise.all([
    priceOfCoin(peg.to, "usd"),
    weightedPrice(coin, "usd", PEG_CHECK_MIN_SOURCES),
  ]);
  if (anchor === undefined || own === undefined) return undefined;

  const anchorUnits = decimalStrToBigInt(anchor, PRICE_DECIMALS)!;
  const ownUnits = decimalStrToBigInt(own, PRICE_DECIMALS)!;
  const gap = anchorUnits > ownUnits ? anchorUnits - ownUnits : ownUnits - anchorUnits;

  return gap * 10_000n > peg.maxDeviationBps * anchorUnits ? undefined : anchor;
}

async function weightedPrice(
  coin: string,
  currency: Currency,
  minSources: number,
): Promise<string | undefined> {
  const configuredMarkets = markets[coin]?.[currency];

  if (!configuredMarkets) return undefined;

  const availableExchanges = exchangeNames.filter(
    (exchange) =>
      configuredMarkets[exchange] !== undefined &&
      !excludedFromWeighting.has(exchange),
  );

  if (availableExchanges.length < minSources) {
    return undefined;
  }

  const results = await Promise.allSettled(
    availableExchanges.map((exchange) => getTicker(exchange, coin, currency)),
  );

  const now = Date.now();
  const tickers: Ticker[] = [];

  // Check timestamps together once the whole batch has finished.
  for (const result of results) {
    if (result.status !== "fulfilled" || result.value === undefined) {
      continue;
    }

    const ticker = result.value;
    const receivedAge = now - ticker.receivedAtMs;

    if (receivedAge < -MAX_FUTURE_MS || receivedAge > MAX_AGE_MS) {
      continue;
    }

    if (ticker.sourceTimeMs !== null) {
      const sourceAge = now - ticker.sourceTimeMs;

      if (sourceAge < -MAX_FUTURE_MS || sourceAge > MAX_AGE_MS) {
        continue;
      }
    }

    tickers.push(ticker);
  }

  const kept = withoutOutliers(tickers, coin, currency);

  if (kept.length < minSources) return undefined;

  let weightedTotal = 0n;
  let totalVolume = 0n;

  for (const ticker of kept) {
    weightedTotal += (ticker.bid + ticker.ask) * ticker.volume;

    totalVolume += ticker.volume;
  }

  const scaleDifference = 10n ** BigInt(CALCULATION_DECIMALS - PRICE_DECIMALS);

  // Divide by 2 for the bid/ask midpoint, and rescale to the output precision.
  const denominator = 2n * totalVolume * scaleDifference;

  let price = weightedTotal / denominator;
  const remainder = weightedTotal % denominator;

  // Round half up, once, on the final result.
  if (remainder * 2n >= denominator) {
    price += 1n;
  }

  if (price === 0n) return undefined;

  return intToDecimalStr(price, PRICE_DECIMALS);
}

/**
 * A ticker exactly at the limit is kept. An even count's median is the mean of
 * the two middle midpoints; doubling every bid + ask keeps that mean, and the
 * comparison, in whole bigints.
 */
function withoutOutliers(tickers: Ticker[], coin: string, currency: Currency): Ticker[] {
  if (tickers.length === 0) return tickers;

  const sums = tickers.map((t) => t.bid + t.ask).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sums.length / 2);
  const twiceMedianSum =
    sums.length % 2 === 1 ? 2n * sums[middle] : sums[middle - 1] + sums[middle];

  const limitBps = outlierLimitBps(coin, currency);
  const kept: Ticker[] = [];
  const dropped: string[] = [];

  for (const ticker of tickers) {
    const gap = 2n * (ticker.bid + ticker.ask) - twiceMedianSum;
    const distance = gap < 0n ? -gap : gap;

    if (distance * 10_000n > limitBps * twiceMedianSum) {
      dropped.push(`${ticker.exchange} ${gap > 0n ? "+" : ""}${percent(gap, twiceMedianSum)}`);
    } else {
      kept.push(ticker);
    }
  }

  if (dropped.length > 0) {
    // twiceMedianSum is 4 × the median midpoint, at CALCULATION_DECIMALS.
    const median = intToDecimalStr(
      twiceMedianSum / (4n * 10n ** BigInt(CALCULATION_DECIMALS - PRICE_DECIMALS)),
      PRICE_DECIMALS,
    );
    console.warn(
      `Price sources dropped as outliers for ${coin}/${currency} (median ${median}, limit ${percent(limitBps, 10_000n)}):`,
      dropped.join(", "),
      `(${kept.length} kept)`,
    );
  }

  return kept;
}

/** part / whole as a percentage with 2 decimals, truncated; for logs only. */
function percent(part: bigint, whole: bigint): string {
  const hundredths = (part * 10_000n) / whole;
  const size = hundredths < 0n ? -hundredths : hundredths;
  return `${part < 0n ? "-" : ""}${size / 100n}.${(size % 100n).toString().padStart(2, "0")}%`;
}

/**
 * Expands scientific notation in raw JSON number text.
 * For example, "1.25e-3" → "0.00125".
 */
export function expandNumber(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);

  if (!match || value.length > 100) {
    throw new Error("Invalid numeric value");
  }

  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const shift = Number(exponent);

  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 100) {
    throw new Error("Numeric exponent is out of range");
  }

  const digits = whole + fraction;
  const position = whole.length + shift;

  if (position <= 0) {
    return sign + "0." + "0".repeat(-position) + digits;
  }

  if (position >= digits.length) {
    return sign + digits + "0".repeat(position - digits.length);
  }

  return sign + digits.slice(0, position) + "." + digits.slice(position);
}

