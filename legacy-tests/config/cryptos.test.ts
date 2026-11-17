import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cryptos,
  explorerTransactionUrl,
  findNetwork,
  isPayable,
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
      enabled: true,
      networks: {
        bitcoin: {
          name: "Bitcoin",
          enabled: true,
          decimals: 8,
          requiredConfirmations: 1,
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

  it("requires at least one confirmation, because zero would settle an unconfirmed payment", () => {
    assert.throws(() => parseCryptoConfig(withNetwork({ requiredConfirmations: 0 })));
    assert.throws(() => parseCryptoConfig(withNetwork({ requiredConfirmations: -3 })));
    assert.throws(() => parseCryptoConfig(withNetwork({ requiredConfirmations: 1.5 })));
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
        enabled: true,
        networks: {
          ethereum: {
            name: "Ethereum",
            enabled: true,
            decimals: 18,
            requiredConfirmations: 10,
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
    assert.equal(bitcoin.requiredConfirmations, 1);
    assert.equal(bitcoin.enabled, true);
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

  it("carries the confirmation depth each chain needs, which differs widely", () => {
    // From v2's config.yml `confs` — the values its poller actually used.
    // Its cryptos.json claims 1 for every asset, which contradicts them.
    assert.equal(findNetwork("ltc", "litecoin")?.requiredConfirmations, 3);
    assert.equal(findNetwork("eth", "ethereum")?.requiredConfirmations, 10);
    assert.equal(findNetwork("xmr", "monero")?.requiredConfirmations, 10);
    assert.equal(findNetwork("usdt", "solana")?.requiredConfirmations, 1);
  });

  it("marks only what is implemented as payable", () => {
    assert.equal(cryptos.btc?.enabled, true);
    assert.equal(cryptos.usdt?.enabled, false, "usdt is described, not built");
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

describe("isPayable", () => {
  // Two switches answering different questions: "we no longer support this
  // asset" and "this one chain is degraded or not built yet".
  it("is true only where an implementation actually exists", () => {
    assert.equal(isPayable("btc", "bitcoin"), true);
  });

  it("is false for an asset described in the table but not implemented", () => {
    // The table documents 13 (asset, network) pairs; one of them is built.
    // Without this, a /coins endpoint would advertise assets that cannot pay.
    assert.equal(isPayable("usdt", "ethereum"), false);
    assert.equal(isPayable("eth", "ethereum"), false);
    assert.equal(isPayable("xmr", "monero"), false);
  });

  it("is false for anything unknown, and never throws", () => {
    assert.equal(isPayable("doge", "dogecoin"), false);
    assert.equal(isPayable("btc", "lightning"), false);
    for (const key of INHERITED_KEYS) {
      assert.equal(isPayable(key, "bitcoin"), false);
      assert.equal(isPayable("btc", key), false);
    }
  });

  it("is false when either switch is off", () => {
    const assetOff = parseCryptoConfig(
      JSON.parse(JSON.stringify(validConfig())) as Record<string, unknown>,
    );
    assert.equal(assetOff.btc?.enabled, true);

    const networkOff = parseCryptoConfig(withNetwork({ enabled: false }));
    assert.equal(networkOff.btc?.networks.bitcoin?.enabled, false);
  });
});

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
