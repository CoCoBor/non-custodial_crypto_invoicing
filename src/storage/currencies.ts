// The fiat currencies an invoice can be priced in, with their ISO 4217 minor
// units (SIX ISO 4217 list one, published 2026-09-17). RUB is out of scope.
export const FIAT_CURRENCIES = {
  usd: 2,
  eur: 2,
  gbp: 2,
  inr: 2,
  pkr: 2,
  vnd: 0,
  brl: 2,
  ngn: 2,
  idr: 2,
  uah: 2,
  php: 2,
  myr: 2,
} as const;

export type FiatCode = keyof typeof FIAT_CURRENCIES;

export function isFiatCode(value: string): value is FiatCode {
  return Object.hasOwn(FIAT_CURRENCIES, value);
}
