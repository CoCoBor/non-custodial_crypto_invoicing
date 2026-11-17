import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRICE_EXTRA_SCALE,
  quoteFromFiat,
  type QuoteInput,
} from "../../src/pricing/quote.js";

const USD_DECIMALS = 2;
const BTC_DECIMALS = 8;

function input(overrides: Partial<QuoteInput> = {}): QuoteInput {
  return {
    fiatAmount: "100.00",
    currencyDecimals: USD_DECIMALS,
    price: "65432.10",
    cryptoDecimals: BTC_DECIMALS,
    ...overrides,
  };
}

describe("converting a fiat amount into the asset's smallest unit", () => {
  it("prices $100.00 at $65432.10 per BTC as 152831 satoshi", () => {
    // 100 / 65432.10 = 0.0015283018... BTC = 152830.18... satoshi
    assert.deepEqual(quoteFromFiat(input()), {
      amountSmallestUnit: 152_831,
      amountFiatMinorUnits: 10_000,
    });
  });

  it("divides exactly when the rate divides exactly, adding nothing", () => {
    // $1.00 at $100.00 per BTC is 0.01 BTC, with no remainder to round.
    assert.equal(
      quoteFromFiat(input({ fiatAmount: "1.00", price: "100.00" }))
        ?.amountSmallestUnit,
      1_000_000,
    );
  });

  it("carries the fiat figure through as minor units, to be frozen on the invoice", () => {
    assert.equal(
      quoteFromFiat(input({ fiatAmount: "24.99" }))?.amountFiatMinorUnits,
      2_499,
    );
  });

  it("works for an 18-decimal asset, where the intermediate exceeds a double", () => {
    // $0.01 at $1000.00 is 0.00001 of a coin, which is 10^13 of its smallest unit.
    assert.equal(
      quoteFromFiat(
        input({
          fiatAmount: "0.01",
          price: "1000.00",
          cryptoDecimals: 18,
        }),
      )?.amountSmallestUnit,
      10_000_000_000_000,
    );
  });

  it("accepts a price carrying the full sub-unit precision it is allowed", () => {
    const price = `1.${"0".repeat(USD_DECIMALS + PRICE_EXTRA_SCALE)}`;
    assert.equal(
      quoteFromFiat(input({ fiatAmount: "1.00", price }))?.amountSmallestUnit,
      100_000_000,
    );
  });
});

describe("rounding direction", () => {
  it("rounds up, so the payer is never asked for less than the invoice is worth", () => {
    // $0.01 / $3.00 = 333333.33 satoshi. Rounding to nearest would give 333333
    // and leave every such invoice one satoshi short, therefore underpaid.
    assert.equal(
      quoteFromFiat(input({ fiatAmount: "0.01", price: "3.00" }))
        ?.amountSmallestUnit,
      333_334,
    );
  });

  it("rounds a remainder up even when it is a single unit", () => {
    // $0.03 / $3.00 = 1000000 exactly; $0.03 / $2.99... is just above.
    const exact = quoteFromFiat(input({ fiatAmount: "0.03", price: "3.00" }));
    assert.equal(exact?.amountSmallestUnit, 1_000_000);

    const justOver = quoteFromFiat(
      input({ fiatAmount: "0.03", price: "2.99999999" }),
    );
    assert.ok(justOver !== undefined);
    assert.ok(justOver.amountSmallestUnit > 1_000_000);
  });
});

describe("refusing to produce a quote", () => {
  it("refuses an invoice for nothing", () => {
    assert.equal(quoteFromFiat(input({ fiatAmount: "0.00" })), undefined);
  });

  it("refuses a zero price rather than dividing by it", () => {
    assert.equal(quoteFromFiat(input({ price: "0.00" })), undefined);
  });

  it("refuses a fiat amount finer than the currency, rather than rounding it", () => {
    assert.equal(quoteFromFiat(input({ fiatAmount: "100.005" })), undefined);
  });

  it("refuses a price finer than the precision it carries", () => {
    const price = `1.${"0".repeat(USD_DECIMALS + PRICE_EXTRA_SCALE + 1)}`;
    assert.equal(quoteFromFiat(input({ price })), undefined);
  });

  it("refuses malformed input from either side", () => {
    assert.equal(quoteFromFiat(input({ fiatAmount: "1e2" })), undefined);
    assert.equal(quoteFromFiat(input({ fiatAmount: "-1.00" })), undefined);
    assert.equal(quoteFromFiat(input({ price: "not a price" })), undefined);
    assert.equal(quoteFromFiat(input({ price: "" })), undefined);
  });

  it("refuses a result past Number.MAX_SAFE_INTEGER instead of returning a wrong one", () => {
    // $100,000,000 at one cent per coin is 10^18 satoshi. The bigint arithmetic
    // is exact; converting it to a number would not be, so it is rejected.
    assert.equal(
      quoteFromFiat(input({ fiatAmount: "100000000.00", price: "0.01" })),
      undefined,
    );
  });
});

describe("decimals come from validated config, so a bad one is our bug", () => {
  it("throws on impossible crypto decimals", () => {
    for (const cryptoDecimals of [-1, 1.5, 37, Number.NaN]) {
      assert.throws(
        () => quoteFromFiat(input({ cryptoDecimals })),
        `expected cryptoDecimals ${cryptoDecimals} to throw`,
      );
    }
  });

  it("throws on impossible currency decimals", () => {
    for (const currencyDecimals of [-1, 1.5, 19, Number.NaN]) {
      assert.throws(
        () => quoteFromFiat(input({ currencyDecimals })),
        `expected currencyDecimals ${currencyDecimals} to throw`,
      );
    }
  });

  it("accepts a zero-decimal currency such as JPY", () => {
    assert.equal(
      quoteFromFiat(
        input({ fiatAmount: "100", currencyDecimals: 0, price: "100" }),
      )?.amountSmallestUnit,
      100_000_000,
    );
  });
});
