import { z } from "zod";

import { FIAT_CURRENCIES, isFiatCode, type FiatCode } from "../storage/currencies.js";
import { expandNumber } from "./price.function.js";

/**
 * How many units of a fiat currency one US dollar buys, as exact decimal
 * text, and when the provider last updated it (unix ms).
 */
export type FxRate = { rate: string; at: number };

/** USD → fiat rates from one provider, keyed by lowercase ISO code. */
export type FxTable = { at: number; rates: Partial<Record<FiatCode, string>> };

// Both providers update once a day; 48 hours allows one missed update.
export const FX_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const FX_MAX_FUTURE_MS = 5 * 60 * 1000;
const CACHE_MS = 60 * 60 * 1000;
const FAILURE_CACHE_MS = 5 * 60 * 1000;

export function isFreshFxRate(rate: FxRate, now: number): boolean {
  return now - rate.at <= FX_MAX_AGE_MS && rate.at - now <= FX_MAX_FUTURE_MS;
}

// Rates are kept as the provider's own digits: JSON.parse would round them
// through a float.
function parseKeepingNumberText(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!context?.source) throw new Error("Original JSON number is unavailable");
    return expandNumber(context.source);
  });
}

const rateText = z.string().max(40).regex(/^[0-9]+(?:\.[0-9]+)?$/).refine((text) => /[1-9]/.test(text));

function fiatRates(rates: Record<string, unknown>): FxTable["rates"] {
  const picked: FxTable["rates"] = {};
  for (const [code, value] of Object.entries(rates)) {
    const fiat = code.toLowerCase();
    if (!isFiatCode(fiat)) continue;
    const parsed = rateText.safeParse(value);
    if (parsed.success) picked[fiat] = parsed.data;
  }
  return picked;
}

const exchangeRateApiSchema = z.object({
  result: z.literal("success"),
  base_code: z.literal("USD"),
  time_last_update_unix: z.string().regex(/^[0-9]{1,12}$/),
  conversion_rates: z.record(z.string(), z.unknown()),
});

/** ExchangeRate-API v6 `latest/USD` (https://www.exchangerate-api.com/docs/standard-requests). */
export function parseExchangeRateApi(text: string): FxTable | undefined {
  try {
    const parsed = exchangeRateApiSchema.safeParse(parseKeepingNumberText(text));
    if (!parsed.success) return undefined;
    return {
      at: Number(parsed.data.time_last_update_unix) * 1000,
      rates: fiatRates(parsed.data.conversion_rates),
    };
  } catch {
    return undefined;
  }
}

const currencyApiSchema = z.object({
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  usd: z.record(z.string(), z.unknown()),
});

/**
 * fawazahmed0 currency-api `v1/currencies/usd.json`. It carries only the
 * rates' date, so the rates count as published at that day's start (UTC).
 */
export function parseCurrencyApi(text: string): FxTable | undefined {
  try {
    const parsed = currencyApiSchema.safeParse(parseKeepingNumberText(text));
    if (!parsed.success) return undefined;
    const at = Date.parse(`${parsed.data.date}T00:00:00Z`);
    if (Number.isNaN(at)) return undefined;
    return { at, rates: fiatRates(parsed.data.usd) };
  } catch {
    return undefined;
  }
}

type FxSource = { url: string; parse: (text: string) => FxTable | undefined };

export const CURRENCY_API_URLS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
] as const;

/**
 * The USD → fiat port: ExchangeRate-API's keyed plan when a key is set, then
 * the keyless currency-api on jsDelivr, then its Cloudflare Pages mirror. A
 * source's table is cached for an hour (a failure for 5 minutes); the first
 * fresh rate wins. undefined: no source has a fresh rate.
 */
export function createUsdToFiat(options: {
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
}): (currency: FiatCode) => Promise<FxRate | undefined> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const sources: FxSource[] = [
    ...(options.apiKey
      ? [
          {
            url: `https://v6.exchangerate-api.com/v6/${encodeURIComponent(options.apiKey)}/latest/USD`,
            parse: parseExchangeRateApi,
          },
        ]
      : []),
    ...CURRENCY_API_URLS.map((url) => ({ url, parse: parseCurrencyApi })),
  ];
  const cache = new Map<FxSource, { table: Promise<FxTable | undefined>; until: number | undefined }>();

  async function load(source: FxSource): Promise<FxTable | undefined> {
    try {
      const response = await doFetch(source.url, {
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return undefined;
      return source.parse(await response.text());
    } catch {
      return undefined;
    }
  }

  function tableOf(source: FxSource): Promise<FxTable | undefined> {
    const cached = cache.get(source);
    if (cached && (cached.until === undefined || now() < cached.until)) return cached.table;

    const entry: { table: Promise<FxTable | undefined>; until: number | undefined } = {
      table: load(source),
      until: undefined,
    };
    cache.set(source, entry);
    void entry.table.then((table) => {
      entry.until = now() + (table ? CACHE_MS : FAILURE_CACHE_MS);
    });
    return entry.table;
  }

  return async (currency) => {
    if (!Object.hasOwn(FIAT_CURRENCIES, currency)) return undefined;
    if (currency === "usd") return { rate: "1", at: now() };

    for (const source of sources) {
      const table = await tableOf(source);
      const rate = table?.rates[currency];
      if (table && rate !== undefined && isFreshFxRate({ rate, at: table.at }, now())) {
        return { rate, at: table.at };
      }
    }
    return undefined;
  };
}
