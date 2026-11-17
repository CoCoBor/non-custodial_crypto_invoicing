import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateWeightedPrice,
  type MarketTicker,
  type WeightedPriceInput,
} from "../../src/pricing/weighted-price.js";

// Every source below quotes a $1.00 spread either side of its midpoint, so the
// midpoint a test cares about is easy to read off the bid: mid = bid + 1.
function source(bid: string, ask: string, volume = "1"): MarketTicker {
  return { bid, ask, volume };
}

// Four sources is the minimum the aggregator accepts, so a fixture that starts
// at exactly four lets a test remove one and land on the "too few" path.
function input(overrides: Partial<WeightedPriceInput> = {}): WeightedPriceInput {
  return {
    tickers: [
      source("99", "101", "1"), // midpoint 100
      source("109", "111", "2"), // midpoint 110, counted twice
      source("119", "121", "1"), // midpoint 120
      source("129", "131", "1"), // midpoint 130
    ],
    priceDecimals: 2,
    volumeDecimals: 0,
    ...overrides,
  };
}

// A source quoting an absurd price with an enormous volume. If a discard ever
// stops working, this drags the result far enough to fail loudly rather than
// shifting it by a rounding step.
const DECOY_VOLUME = "1000000";

describe("weighting exchange midpoints by volume", () => {
  it("lets a busier exchange count for more than a quiet one", () => {
    // A plain average of 100, 110, 120, 130 would be 115. The 110 source traded
    // twice the volume, so the weighted answer is pulled down to 114:
    //   (100x1 + 110x2 + 120x1 + 130x1) / 5 = 570 / 5 = 114
    assert.equal(calculateWeightedPrice(input()), "114");
  });

  it("uses the midpoint of each book rather than the bid or the ask", () => {
    // Every source is 90/110, so bid-only would say 90 and ask-only 110.
    assert.equal(
      calculateWeightedPrice(
        input({ tickers: Array(4).fill(source("90", "110", "1")) }),
      ),
      "100",
    );
  });
});

describe("rounding the aggregate price to the requested precision", () => {
  // Four equal-volume sources, so the result is the plain average of their
  // midpoints. Midpoints one cent apart put the average onto a quarter cent,
  // which is where the remainder handling has to make a decision.
  const at100 = source("99.00", "101.00", "1"); // midpoint 100.00
  const at100_01 = source("99.01", "101.01", "1"); // midpoint 100.01

  function averageOf(sources: MarketTicker[]): string | undefined {
    return calculateWeightedPrice(input({ tickers: sources }));
  }

  it("rounds down when the dropped remainder is under half a unit", () => {
    // average 100.0025
    assert.equal(averageOf([at100, at100, at100, at100_01]), "100");
  });

  it("rounds up when the dropped remainder is exactly half a unit", () => {
    // average 100.0050 — the tie, which this function breaks upwards.
    assert.equal(averageOf([at100, at100, at100_01, at100_01]), "100.01");
  });

  it("rounds up when the dropped remainder is over half a unit", () => {
    // average 100.0075
    assert.equal(averageOf([at100, at100_01, at100_01, at100_01]), "100.01");
  });

  it("adds nothing when the division comes out exact", () => {
    // Guards the `+ 1n` branch against firing on a zero remainder, which would
    // overcharge every invoice by one unit of the last decimal place.
    assert.equal(averageOf([at100, at100, at100, at100]), "100");
  });
});

describe("discarding sources that cannot be used", () => {
  it("returns no price at all when fewer than four sources survive", () => {
    // Not zero: failing to reach a price is not the same as the price being
    // zero, and a zero would let an invoice be settled for nothing.
    assert.equal(
      calculateWeightedPrice(
        input({
          tickers: [
            source("99", "101", "1"),
            source("109", "111", "2"),
            source("119", "121", "1"),
            source("not a number", "131", "1"),
          ],
        }),
      ),
      undefined,
    );
  });

  it("returns no price for an empty ticker list", () => {
    assert.equal(calculateWeightedPrice(input({ tickers: [] })), undefined);
  });

  it("drops an unparseable bid", () => {
    assert.equal(
      calculateWeightedPrice(
        input({
          tickers: [...input().tickers, source("", "99999", DECOY_VOLUME)],
        }),
      ),
      "114",
    );
  });

  it("drops an unparseable ask", () => {
    assert.equal(
      calculateWeightedPrice(
        input({
          tickers: [...input().tickers, source("99999", "?!", DECOY_VOLUME)],
        }),
      ),
      "114",
    );
  });

  it("drops a source with no trading volume, which has earned no weight", () => {
    assert.equal(
      calculateWeightedPrice(
        input({
          tickers: [...input().tickers, source("99999", "100001", "0")],
        }),
      ),
      "114",
    );
  });

  it("returns no price when every source is idle, rather than dividing by zero", () => {
    // A zero-volume source cancels itself out of a weighted average, so the
    // discard only shows its worth here: kept, these four would sum to a zero
    // total volume and the final division would throw.
    assert.equal(
      calculateWeightedPrice(
        input({ tickers: Array(4).fill(source("99", "101", "0")) }),
      ),
      undefined,
    );
  });

  it("drops a zero bid rather than letting it drag the midpoint down", () => {
    assert.equal(
      calculateWeightedPrice(
        input({
          tickers: [...input().tickers, source("0", "99999", DECOY_VOLUME)],
        }),
      ),
      "114",
    );
  });

  it("drops a quote carrying more decimals than priceDecimals allows", () => {
    // Worth pinning down because it is silent: raise the precision an exchange
    // reports without raising priceDecimals and its data quietly stops
    // counting, leaving the price built from whoever happens to quote coarsely.
    assert.equal(
      calculateWeightedPrice(
        input({
          tickers: [
            ...input().tickers,
            source("99999.123", "100001.456", DECOY_VOLUME),
          ],
        }),
      ),
      "114",
    );
  });
});

describe("honouring the scale parameters it is given", () => {
  it("weights by fractional volume when volumeDecimals allows it", () => {
    //   (100x1.5 + 200x0.5 + 100x1.5 + 100x1.5) / 5.0 = 550 / 5 = 110
    // Read volume as a whole number instead and "1.5" stops parsing, leaving
    // one valid source and no price at all.
    assert.equal(
      calculateWeightedPrice(
        input({
          tickers: [
            source("99", "101", "1.5"),
            source("199", "201", "0.5"),
            source("99", "101", "1.5"),
            source("99", "101", "1.5"),
          ],
          volumeDecimals: 1,
        }),
      ),
      "110",
    );
  });

  it("returns a whole number without a trailing point at zero priceDecimals", () => {
    // average 100.5, which rounds up, and must not come back as "101." here.
    assert.equal(
      calculateWeightedPrice(
        input({
          tickers: [
            source("99", "101", "1"), // midpoint 100
            source("99", "101", "1"), // midpoint 100
            source("100", "102", "1"), // midpoint 101
            source("100", "102", "1"), // midpoint 101
          ],
          priceDecimals: 0,
        }),
      ),
      "101",
    );
  });

  it("keeps the leading zero on a price below one", () => {
    // ".05" would be read as a different number, or as nothing, by a parser.
    assert.equal(
      calculateWeightedPrice(
        input({ tickers: Array(4).fill(source("0.04", "0.06", "1")) }),
      ),
      "0.05",
    );
  });

  it("reports the price at the precision it was asked for", () => {
    // Same sources as the weighting test, read at eight decimals instead of
    // two: the trailing zeroes are trimmed, so the figure is unchanged.
    assert.equal(calculateWeightedPrice(input({ priceDecimals: 8 })), "114");
  });
});

describe("rejecting scales it cannot work in", () => {
  // These fire before any ticker is read. Left to the parser inside .map(),
  // an empty ticker list would skip the check entirely and the caller would
  // get a quiet `undefined` that looks like "not enough exchanges".
  it("throws on a fractional priceDecimals even with nothing to parse", () => {
    assert.throws(
      () => calculateWeightedPrice(input({ tickers: [], priceDecimals: 2.5 })),
      RangeError,
    );
  });

  it("throws on a fractional volumeDecimals even with nothing to parse", () => {
    assert.throws(
      () => calculateWeightedPrice(input({ tickers: [], volumeDecimals: 1.5 })),
      RangeError,
    );
  });

  it("throws on a negative scale", () => {
    assert.throws(() => calculateWeightedPrice(input({ priceDecimals: -1 })));
    assert.throws(() => calculateWeightedPrice(input({ volumeDecimals: -1 })));
  });

  it("throws on a scale large enough to be a resource attack", () => {
    // The scale drives `10n ** scale` and a padStart of that width, so an
    // unbounded value is a way to exhaust memory rather than a real currency.
    assert.throws(() => calculateWeightedPrice(input({ priceDecimals: 37 })));
    assert.throws(() => calculateWeightedPrice(input({ volumeDecimals: 37 })));
  });
});
