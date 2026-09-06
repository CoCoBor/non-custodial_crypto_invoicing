import { z } from "zod";
import rawCurrencies from "./currencies.json" with { type: "json" };

const currencyConfigSchema = z.object({
  name: z.string().min(1),
  sign: z.string().min(1),
  decimals: z.number().int().nonnegative().max(18),
});

const currencyMapSchema = z.record(z.string(), currencyConfigSchema);

export type CurrencyConfig = z.infer<typeof currencyConfigSchema>;

export function parseCurrencyConfig(raw: unknown): z.infer<typeof currencyMapSchema> {
  const result = currencyMapSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(`invalid currency config: ${result.error.message}`);
  }

  return result.data;
}

export const currencies = parseCurrencyConfig(rawCurrencies);

export function findCurrency(code: string): CurrencyConfig | undefined {
  return Object.hasOwn(currencies, code) ? currencies[code]: undefined
}

