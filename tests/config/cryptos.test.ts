import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cryptos,
  explorerTransactionUrl,
  findNetwork,
  parseCryptoConfig,
} from "../../src/config/cryptos.js";
import {
  currencies,
  findCurrency,
  parseCurrencyConfig,
} from "../../src/config/currencies.js";

// The config file is untrusted input in the same sense a provider response is:
// hand-edited, not typechecked, and a mistake in it surfaces at the worst
// possible moment. It is validated on load, and the process refuses to start
// if it is wrong.

function validConfig(): Record<string, unknown> {
  return {
    btc: {
      name: "Bitcoin",
      networks: {
        bitcoin: {
          name: "Bitcoin",
          decimals: 8,
          dustThreshold: 546,
          explorerTransactionUrl: "https://mempool.space/tx/{txId}",
        },
      },
    },
  };
}

function withNetwork(changes: Record<string, unknown>): Record<string, unknown> {
  const config = validConfig();
  const btc = config.btc as { networks: { bitcoin: Record<string, unknown> } };
  btc.networks.bitcoin = { ...btc.networks.bitcoin, ...changes };

  return config;
}

describe("parseCryptoConfig", () => {
  it("accepts a well-formed table", () => {
    assert.equal(parseCryptoConfig(validConfig()).btc?.networks.bitcoin?.decimals, 8);
  });

  it("throws rather than returning undefined, because a bad asset table is not recoverable", () => {
    assert.throws(() => parseCryptoConfig({ btc: { name: "Bitcoin" } }));
    assert.throws(() => parseCryptoConfig(null));
    assert.throws(() => parseCryptoConfig("not an object"));
  });

  it("rejects an asset with no networks, which would be payable in principle and unpayable in fact", () => {
    const config = validConfig();
    (config.btc as { networks: unknown }).networks = {};

    assert.throws(() => parseCryptoConfig(config));
  });

  it("rejects a fractional threshold, because amounts are integers in the smallest unit", () => {
    assert.throws(() => parseCryptoConfig(withNetwork({ dustThreshold: 546.5 })));
  });

  it("rejects a negative threshold", () => {
    assert.throws(() => parseCryptoConfig(withNetwork({ dustThreshold: -546 })));
  });

  it("rejects a threshold beyond safe-integer range, where arithmetic stops being exact", () => {
    assert.throws(() =>
      parseCryptoConfig(withNetwork({ dustThreshold: Number.MAX_SAFE_INTEGER + 2 })),
    );
  });

  it("rejects impossible decimals", () => {
    assert.throws(() => parseCryptoConfig(withNetwork({ decimals: -1 })));
    assert.throws(() => parseCryptoConfig(withNetwork({ decimals: 1.5 })));
    assert.throws(() => parseCryptoConfig(withNetwork({ decimals: 78 })));
  });

  it("rejects an explorer template missing its placeholder, which would produce a dead link", () => {
    assert.throws(() =>
      parseCryptoConfig(withNetwork({ explorerTransactionUrl: "https://mempool.space/tx/" })),
    );
  });

  // dustThreshold is a UTXO concept. Account-model chains have no protocol
  // dust limit, so the field is absent rather than invented.
  it("accepts a network with no dust threshold", () => {
    const parsed = parseCryptoConfig({
      eth: {
        name: "Ethereum",
        networks: {
          ethereum: {
            name: "Ethereum",
            decimals: 18,
            explorerTransactionUrl: "https://etherscan.io/tx/{txId}",
          },
        },
      },
    });

    assert.equal(parsed.eth?.networks.ethereum?.dustThreshold, undefined);
  });

  it("accepts a token's contract address, and leaves it undefined for a native asset", () => {
    const parsed = parseCryptoConfig(
      withNetwork({ contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }),
    );

    assert.equal(
      parsed.btc?.networks.bitcoin?.contractAddress,
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    );
    assert.equal(
      parseCryptoConfig(validConfig()).btc?.networks.bitcoin?.contractAddress,
      undefined,
    );
  });
});

describe("the shipped cryptos.json", () => {
  // Catches a typo in the real file at test time rather than at boot.
  it("describes bitcoin the way the rest of the code assumes", () => {
    const bitcoin = findNetwork("btc", "bitcoin");
    assert.ok(bitcoin, "bitcoin must be present");

    assert.equal(bitcoin.decimals, 8);
    assert.equal(bitcoin.dustThreshold, 546);
  });

  // The reason the table nests networks under an asset rather than using one
  // flat key per pair. USDT is one asset whose smallest unit differs by chain;
  // a flat "usdteth" / "usdtbsc" table can only express that by encoding the
  // chain into the key and parsing it back out.
  it("gives one USDT three networks with different decimals", () => {
    assert.equal(findNetwork("usdt", "ethereum")?.decimals, 6);
    assert.equal(findNetwork("usdt", "bsc")?.decimals, 18);
    assert.equal(findNetwork("usdt", "solana")?.decimals, 6);
  });

  it("carries the token contract address per network", () => {
    assert.equal(
      findNetwork("usdt", "ethereum")?.contractAddress,
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    );
    assert.equal(
      findNetwork("usdc", "solana")?.contractAddress,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  it("leaves native assets without a contract address", () => {
    assert.equal(findNetwork("btc", "bitcoin")?.contractAddress, undefined);
    assert.equal(findNetwork("eth", "ethereum")?.contractAddress, undefined);
  });

  it("has every asset the reference implementation supported", () => {
    for (const [asset, network] of [
      ["btc", "bitcoin"], ["ltc", "litecoin"], ["eth", "ethereum"],
      ["sol", "solana"], ["xmr", "monero"], ["ton", "ton"],
      ["usdt", "ethereum"], ["usdt", "bsc"], ["usdt", "solana"],
      ["usdc", "ethereum"], ["usdc", "bsc"], ["usdc", "solana"],
      ["dai", "ethereum"],
    ]) {
      assert.ok(findNetwork(asset!, network!), `${asset} on ${network} is missing`);
    }
  });
});

// Keys every plain object inherits from Object.prototype. A plain `obj[key]`
// lookup resolves these to functions rather than undefined, so an asset name
// taken from a request body can reach one.
const INHERITED_KEYS = [
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
  "valueOf",
];

describe("findNetwork", () => {
  it("returns undefined for an unknown asset or network instead of throwing", () => {
    assert.equal(findNetwork("doge", "dogecoin"), undefined);
    assert.equal(findNetwork("btc", "lightning"), undefined);
    assert.equal(findNetwork("", ""), undefined);
  });

  it("treats inherited object keys as unknown, because a lookup must never throw on user input", () => {
    for (const key of INHERITED_KEYS) {
      assert.equal(
        findNetwork(key, "bitcoin"),
        undefined,
        `findNetwork(${JSON.stringify(key)}, "bitcoin") must resolve to undefined`,
      );
      assert.equal(
        findNetwork("btc", key),
        undefined,
        `findNetwork("btc", ${JSON.stringify(key)}) must resolve to undefined`,
      );
    }
  });

  it("does not throw when the explorer helper is given an inherited key", () => {
    for (const key of INHERITED_KEYS) {
      assert.equal(explorerTransactionUrl(key, "bitcoin", "abc"), undefined);
      assert.equal(explorerTransactionUrl("btc", key, "abc"), undefined);
    }
  });
});

describe("explorerTransactionUrl", () => {
  it("substitutes the transaction hash", () => {
    assert.equal(
      explorerTransactionUrl("btc", "bitcoin", "abc123"),
      "https://mempool.space/tx/abc123",
    );
  });

  it("returns undefined for an unknown network rather than a broken link", () => {
    assert.equal(explorerTransactionUrl("doge", "dogecoin", "abc"), undefined);
  });
});

describe("currencies", () => {
  it("describes usd with two decimal places", () => {
    assert.ok(currencies.usd);

    const usd = findCurrency("usd");
    assert.ok(usd);
    assert.equal(usd.decimals, 2);
    assert.equal(usd.sign, "$");
  });

  it("returns undefined for an unknown currency", () => {
    assert.equal(findCurrency("gbp"), undefined);
    assert.equal(findCurrency(""), undefined);
  });

  it("treats inherited object keys as unknown currencies", () => {
    for (const key of INHERITED_KEYS) {
      assert.equal(
        findCurrency(key),
        undefined,
        `findCurrency(${JSON.stringify(key)}) must resolve to undefined, not a function`,
      );
    }
  });

  it("throws on a malformed table", () => {
    assert.throws(() => parseCurrencyConfig({ usd: { name: "Dollar" } }));
    assert.throws(() =>
      parseCurrencyConfig({ usd: { name: "D", sign: "$", decimals: -1 } }),
    );
    assert.throws(() => parseCurrencyConfig(null));
  });
});
