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

// Owner decision 2026-11-19: fetch every 48 hours. Both providers update once
// a day, so a fetched rate can already be up to a day old by the provider's
// time; 72 hours covers that.
export const FX_REFRESH_MS = 48 * 60 * 60 * 1000;
export const FX_MAX_AGE_MS = 72 * 60 * 60 * 1000;
// Fetch again no later than this long before a rate would be refused, so
// failed fetches get this long of retries first.
const FX_REFRESH_MARGIN_MS = 6 * 60 * 60 * 1000;
const FX_RETRY_MS = 5 * 60 * 1000;
const FX_MAX_FUTURE_MS = 5 * 60 * 1000;

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
 * source is fetched again 48 hours after a good fetch (sooner if its rates
 * would come within 6 hours of the 72-hour limit), and 5 minutes after a
 * failed one, which keeps its last good table; the first fresh rate wins.
 * undefined: no source has a fresh rate.
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
  const states = new Map<FxSource, { good?: FxTable; nextFetchAt: number; loading?: Promise<void> }>();

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

  async function tableOf(source: FxSource): Promise<FxTable | undefined> {
    let state = states.get(source);
    if (!state) {
      state = { nextFetchAt: 0 };
      states.set(source, state);
    }
    if (!state.loading && now() >= state.nextFetchAt) {
      const current = state;
      current.loading = load(source).then((table) => {
        const fetchedAt = now();
        if (table && (!current.good || table.at >= current.good.at)) current.good = table;
        current.nextFetchAt =
          table && current.good
            ? Math.max(
                fetchedAt + FX_RETRY_MS,
                Math.min(fetchedAt + FX_REFRESH_MS, current.good.at + FX_MAX_AGE_MS - FX_REFRESH_MARGIN_MS),
              )
            : fetchedAt + FX_RETRY_MS;
        current.loading = undefined;
      });
    }
    if (state.loading) await state.loading;
    return state.good;
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
