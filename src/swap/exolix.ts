import { z } from "zod";

import type { AssetId } from "../assets/payout-address.js";
import { ceilDivide } from "../money/format.js";
import { expandNumber } from "../invoice/price.function.js";
import { intToDecimalStr } from "../invoice/money.function.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import type { QuoteAnswer, SwapPort, SwapRequest, SwapStatus, SwapStatusName } from "./swap-port.js";

// Exolix (API v2, float rate) behind the swap port (swap-port.ts), for pairs
// with XMR on one side: NEAR Intents does not list Monero. Request and reply
// shapes: https://exolix.com/developers. Replies are in tests/fixtures/exolix/.

const API_URL = "https://exolix.com/api/v2";

/** Exolix's coin and network for an asset (cryptos.json `exolix`); undefined: Exolix does not list it. */
export function exolixCode(asset: AssetId): { coin: string; network: string } | undefined {
  const coin = cryptos[asset];
  return "exolix" in coin ? coin.exolix : undefined;
}

const decimalsOf = (asset: AssetId): number => cryptos[asset].decimal;

function assetOf(coin: string, network: string): AssetId | undefined {
  return (Object.keys(cryptos) as AssetId[]).find((asset) => {
    const code = exolixCode(asset);
    return code !== undefined && code.coin === coin.toUpperCase() && code.network === network.toUpperCase();
  });
}

// Exolix writes amounts as JSON numbers. Read through a float they would be
// rounded, so every number is kept as its own text.
function parseKeepingNumbers(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined ? expandNumber(context.source) : value,
  );
}

const amountText = z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/);

/** A decimal amount in smallest units, exactly; digits beyond the asset's decimals round as asked. */
function units(text: string, decimals: number, round: "down" | "up"): bigint {
  const [whole = "0", fraction = ""] = text.split(".");
  const kept = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  return round === "up" && /[1-9]/.test(fraction.slice(decimals)) ? kept + 1n : kept;
}

const rateReplySchema = z.looseObject({
  fromAmount: amountText,
  toAmount: amountText,
});

const errorReplySchema = z.looseObject({
  message: z.string().nullish(),
  error: z.string().nullish(),
  minAmount: amountText.nullish(),
});

const coinSchema = z.looseObject({ coinCode: z.string(), network: z.string() });

const EXOLIX_STATUSES = ["wait", "confirmation", "confirmed", "exchanging", "sending", "success", "overdue", "refund", "refunded"] as const;

const transactionSchema = z.looseObject({
  id: z.string().min(1),
  amount: amountText,
  amountTo: amountText,
  coinFrom: coinSchema,
  coinTo: coinSchema,
  comment: z.string().nullish(),
  depositAddress: z.string().min(1),
  depositExtraId: z.string().nullish(),
  withdrawalAddress: z.string(),
  hashIn: z.looseObject({ hash: z.string().nullish() }).nullish(),
  hashOut: z.looseObject({ hash: z.string().nullish() }).nullish(),
  rateType: z.string().nullish(),
  status: z.enum(EXOLIX_STATUSES),
});

type Transaction = z.infer<typeof transactionSchema>;

// overdue: Exolix gave up waiting for the deposit, but ours was already sent;
// a person must ask Exolix where it is. refund: a refund is under way.
const STATUS_MAP: Record<Transaction["status"], SwapStatusName> = {
  wait: "PENDING_DEPOSIT",
  confirmation: "KNOWN_DEPOSIT_TX",
  confirmed: "PROCESSING",
  exchanging: "PROCESSING",
  sending: "PROCESSING",
  success: "SUCCESS",
  overdue: "FAILED",
  refund: "PROCESSING",
  refunded: "REFUNDED",
};

const BELOW_MINIMUM = /below the possible min/i;

/** A price as an exact positive fraction. */
function fraction(text: string | undefined): { n: bigint; d: bigint } | undefined {
  const match = /^([0-9]+)(?:\.([0-9]{1,36}))?$/.exec(text?.trim() ?? "");
  if (!match) return undefined;
  const digits = match[2] ?? "";
  const n = BigInt(match[1]! + digits);
  return n > 0n ? { n, d: 10n ** BigInt(digits.length) } : undefined;
}

export function createExolixSwap(deps: {
  fetch: typeof globalThis.fetch;
  /** Empty: Exolix is off. It serves no pair, but swaps already open are still followed. */
  apiKey: string;
  /** USD per whole coin from our own pricing; undefined: no price now. */
  usdPrice: (asset: AssetId) => Promise<string | undefined>;
}): SwapPort {
  const on = deps.apiKey !== "";

  const serves = (from: AssetId, to: AssetId) =>
    on && from !== to && (from === "xmr" || to === "xmr") && exolixCode(from) !== undefined && exolixCode(to) !== undefined;

  async function call(path: string, init: { method: "GET" | "POST"; body?: string; timeoutMs: number }) {
    try {
      const response = await deps.fetch(`${API_URL}${path}`, {
        method: init.method,
        headers: {
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(deps.apiKey ? { "api-key": deps.apiKey } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(init.timeoutMs),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = parseKeepingNumbers(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, ok: response.ok, json };
    } catch (error) {
      console.warn("Exolix request failed:", path.split("?")[0], error instanceof Error ? error.message : "unknown error");
      return undefined;
    }
  }

  /** A refusal: too small when Exolix names its minimum, otherwise unavailable. */
  function refusal(what: string, reply: { status: number; json: unknown }, from: AssetId): QuoteAnswer {
    const parsed = errorReplySchema.safeParse(reply.json);
    const text = parsed.success ? (parsed.data.message ?? parsed.data.error ?? "no message") : "no message";
    if (BELOW_MINIMUM.test(text)) {
      const minimum = parsed.success ? parsed.data.minAmount : undefined;
      return { kind: "too_small", ...(minimum ? { minimumIn: units(minimum, decimalsOf(from), "up") } : {}), reason: `Exolix: ${text}` };
    }
    return { kind: "unavailable", reason: `Exolix refused the ${what} (${reply.status}): ${text}` };
  }

  return {
    supports: serves,

    async quote(request: SwapRequest): Promise<QuoteAnswer> {
      const from = exolixCode(request.from);
      const to = exolixCode(request.to);
      if (!serves(request.from, request.to) || from === undefined || to === undefined) {
        return { kind: "unavailable", reason: `Exolix does not serve ${request.from} into ${request.to}${on ? "" : " (no EXOLIX_API_KEY)"}` };
      }
      if (request.amountIn <= 0n) return { kind: "too_small", reason: "nothing to swap" };

      // Exolix's float rate has no slippage guarantee of its own, so the
      // merchant's max loss is checked against our own price before sending.
      const floor = await maxLossFloor(request);
      if (floor === undefined) {
        return { kind: "unavailable", reason: `no price of our own for ${request.from} or ${request.to} to check the max loss against` };
      }

      const amount = intToDecimalStr(request.amountIn, decimalsOf(request.from));
      const pair = { coinFrom: from.coin, networkFrom: from.network, coinTo: to.coin, networkTo: to.network };
      const rateReply = await call(`/rate?${new URLSearchParams({ ...pair, amount, rateType: "float" })}`, { method: "GET", timeoutMs: 10_000 });
      if (rateReply === undefined) return { kind: "unavailable", reason: "Exolix could not be reached" };
      if (!rateReply.ok) return refusal("rate", rateReply, request.from);
      const rate = rateReplySchema.safeParse(rateReply.json);
      if (!rate.success) return { kind: "unavailable", reason: "Exolix's rate reply is unreadable" };
      const rateOut = units(rate.data.toAmount, decimalsOf(request.to), "down");
      if (rateOut < floor) return lossTooHigh(request, rateOut, floor);

      const slippage = intToDecimalStr(BigInt(request.maxLossBps), 2);
      const fields = { ...pair, amount, withdrawalAddress: request.recipient, refundAddress: request.refundTo, rateType: "float", slippage };
      const created = await call("/transactions", { method: "POST", timeoutMs: 15_000, body: jsonWithNumbers(fields, ["amount", "slippage"]) });
      if (created === undefined) return { kind: "unavailable", reason: "Exolix could not be reached" };
      if (!created.ok) return refusal("transaction", created, request.from);
      const parsed = transactionSchema.safeParse(created.json);
      if (!parsed.success) return { kind: "unavailable", reason: "Exolix's transaction reply is unreadable" };
      const transaction = parsed.data;

      const wrong = mismatch(transaction, request, from, to);
      if (wrong) return { kind: "unavailable", reason: `Exolix's transaction ${transaction.id} ${wrong}; nothing is sent to it` };
      const amountOut = units(transaction.amountTo, decimalsOf(request.to), "down");
      if (amountOut < floor) return lossTooHigh(request, amountOut, floor);

      return {
        kind: "ok",
        quote: {
          provider: "exolix",
          swapId: transaction.id,
          depositAddress: transaction.depositAddress,
          amountIn: request.amountIn,
          amountOut,
          minAmountOut: floor,
          record: { quoteRequest: { ...fields, refundTo: request.refundTo }, rate: rateReply.json, transaction: created.json },
        },
      };
    },

    // Exolix has no deposit hint: it watches its deposit address itself.
    start: async () => true,

    async status(swap): Promise<SwapStatus | undefined> {
      if (!swap.swapId) {
        console.warn("Exolix swap has no transaction id; can't look it up:", swap.depositAddress);
        return undefined;
      }
      const reply = await call(`/transactions/${encodeURIComponent(swap.swapId)}`, { method: "GET", timeoutMs: 10_000 });
      if (!reply?.ok) {
        if (reply) console.warn("Exolix swap status request failed:", reply.status, swap.swapId);
        return undefined;
      }
      const parsed = transactionSchema.safeParse(reply.json);
      if (!parsed.success || parsed.data.id !== swap.swapId || parsed.data.depositAddress !== swap.depositAddress) {
        console.warn("Exolix swap status reply is unreadable or for another swap:", swap.swapId);
        return undefined;
      }
      const transaction = parsed.data;
      const status = STATUS_MAP[transaction.status];
      const fromAsset = assetOf(transaction.coinFrom.coinCode, transaction.coinFrom.network);
      const toAsset = assetOf(transaction.coinTo.coinCode, transaction.coinTo.network);
      const hashIn = transaction.hashIn?.hash;
      const hashOut = transaction.hashOut?.hash;
      // hashOut is the delivery while Exolix sends the swapped coin, and the
      // refund's transaction once it refunds.
      const delivering = transaction.status === "sending" || transaction.status === "success";
      return {
        status,
        ...(fromAsset !== undefined && { amountIn: units(transaction.amount, decimalsOf(fromAsset), "down") }),
        ...(toAsset !== undefined && { amountOut: units(transaction.amountTo, decimalsOf(toAsset), "down") }),
        ...(status === "REFUNDED" && {
          refundReason: `${transaction.comment || "Exolix refunded the deposit"}${hashOut ? ` (refund transaction ${hashOut})` : ""}`,
        }),
        ...(status === "FAILED" && {
          refundReason: `Exolix marked transaction ${transaction.id} overdue: it did not see the deposit in time. ${transaction.comment ?? ""}`.trim(),
        }),
        originTxids: hashIn ? [hashIn] : [],
        deliveryTxids: hashOut && delivering ? [hashOut] : [],
      };
    },
  };

  /**
   * The least the merchant may get: what `amountIn` is worth at our own USD
   * prices, less the max loss, rounded up. undefined: no price for a side.
   */
  async function maxLossFloor(request: SwapRequest): Promise<bigint | undefined> {
    const [priceFrom, priceTo] = await Promise.all([deps.usdPrice(request.from), deps.usdPrice(request.to)]);
    const from = fraction(priceFrom);
    const to = fraction(priceTo);
    if (from === undefined || to === undefined) return undefined;
    const keep = 10_000n - BigInt(request.maxLossBps);
    const numerator = request.amountIn * from.n * to.d * 10n ** BigInt(decimalsOf(request.to)) * keep;
    const denominator = from.d * to.n * 10n ** BigInt(decimalsOf(request.from)) * 10_000n;
    return ceilDivide(numerator, denominator);
  }
}

function lossTooHigh(request: SwapRequest, out: bigint, floor: bigint): QuoteAnswer {
  return {
    kind: "unavailable",
    reason: `Exolix would deliver ${out} (smallest ${request.to} units), below ${floor}: more than the merchant's max loss of ${request.maxLossBps} bps under our own price`,
  };
}

/** Why a created transaction is not the one asked for; undefined when it is. */
function mismatch(
  transaction: Transaction,
  request: SwapRequest,
  from: { coin: string; network: string },
  to: { coin: string; network: string },
): string | undefined {
  const same = (coin: { coinCode: string; network: string }, code: { coin: string; network: string }) =>
    coin.coinCode.toUpperCase() === code.coin && coin.network.toUpperCase() === code.network;
  if (transaction.depositExtraId) return "needs an extra id (memo) with the deposit, which our payouts never send";
  if (!same(transaction.coinFrom, from) || !same(transaction.coinTo, to)) return "is for another pair";
  if (transaction.withdrawalAddress !== request.recipient) return "pays another address than the merchant's";
  if (transaction.rateType != null && transaction.rateType !== "float") return `has a ${transaction.rateType} rate, not float`;
  // Exolix reads the amount through a float (0.123456789012345678 ETH came
  // back as 0.12345678901234568), so its echo may differ in the last digits.
  const echo = units(transaction.amount, decimalsOf(request.from), "down");
  const difference = echo > request.amountIn ? echo - request.amountIn : request.amountIn - echo;
  if (difference * 1_000_000_000n > request.amountIn) return `is for ${transaction.amount}, not the amount asked`;
  return undefined;
}

/** JSON with the named fields (exact decimal text) written as bare numbers. */
function jsonWithNumbers(fields: Record<string, string>, numbers: string[]): string {
  const placeholder = (name: string) => `\u0000${name}\u0000`;
  let text = JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, numbers.includes(k) ? placeholder(k) : v])));
  for (const name of numbers) {
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(fields[name] ?? "")) throw new Error(`${name} is not a decimal number`);
    text = text.replace(JSON.stringify(placeholder(name)), fields[name]!);
  }
  return text;
}
