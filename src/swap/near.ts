import { z } from "zod";

import type { AssetId } from "../assets/payout-address.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import type { QuoteAnswer, SwapPort, SwapRequest, SwapStatus } from "./swap-port.js";
import { SWAP_STATUSES } from "./swap-port.js";

// NEAR Intents through its 1Click API, behind the swap port (swap-port.ts).
// Request and reply shapes: https://1click.chaindefuser.com/docs/v0/openapi.yaml.
// Recorded replies are in tests/fixtures/near/.

const API_URL = "https://1click.chaindefuser.com";

// How long NEAR keeps the deposit address open. A deposit that lands after
// the deadline is refunded to refundTo (the invoice's deposit address).
const QUOTE_DEADLINE_MS = 24 * 60 * 60 * 1000;

// A quote with less time left than this is refused: the deposit
// transaction must still be mined and seen before the deadline.
export const MIN_SWAP_TIME_LEFT_MS = 4 * 60 * 60 * 1000;

/** NEAR's id for an asset (cryptos.json `near_asset_id`); undefined: NEAR does not list it. */
export function nearAssetId(asset: AssetId): string | undefined {
  const coin = cryptos[asset];
  return "near_asset_id" in coin ? coin.near_asset_id : undefined;
}

const digits = z.string().regex(/^[0-9]+$/);

const quoteReplySchema = z.looseObject({
  quote: z.looseObject({
    amountIn: digits,
    amountOut: digits,
    minAmountOut: digits,
    depositAddress: z.string().min(1).optional(),
    depositMemo: z.string().optional(),
    deadline: z.string().min(1).optional(),
  }),
});

const errorReplySchema = z.looseObject({ message: z.string() });

const txListSchema = z.array(z.looseObject({ hash: z.string().min(1) }));

const statusReplySchema = z.looseObject({
  status: z.enum(SWAP_STATUSES),
  swapDetails: z.looseObject({
    amountIn: digits.nullish(),
    amountOut: digits.nullish(),
    refundedAmount: digits.nullish(),
    refundReason: z.string().nullish(),
    originChainTxHashes: txListSchema,
    destinationChainTxHashes: txListSchema,
  }),
});

const TOO_LOW = /amount is too low.*?try at least (\d+)/i;

export function createNearIntentsSwap(deps: {
  fetch: typeof globalThis.fetch;
  /** The 1Click JWT. Empty: requests go without one. */
  jwt: string;
  now: () => number;
}): SwapPort {
  const headers = (json: boolean): Record<string, string> => ({
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(deps.jwt ? { Authorization: `Bearer ${deps.jwt}` } : {}),
  });

  async function call(path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number }) {
    try {
      const response = await deps.fetch(`${API_URL}${path}`, {
        method: init.method,
        headers: headers(init.body !== undefined),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(init.timeoutMs),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, ok: response.ok, json };
    } catch (error) {
      console.warn("NEAR 1Click request failed:", path, error instanceof Error ? error.message : "unknown error");
      return undefined;
    }
  }

  return {
    supports: (from, to) => from !== to && nearAssetId(from) !== undefined && nearAssetId(to) !== undefined,

    async quote(request: SwapRequest): Promise<QuoteAnswer> {
      const originAsset = nearAssetId(request.from);
      const destinationAsset = nearAssetId(request.to);
      if (originAsset === undefined || destinationAsset === undefined) {
        return { kind: "unavailable", reason: `NEAR does not list ${request.from} or ${request.to}` };
      }
      if (request.amountIn <= 0n) return { kind: "too_small", reason: "nothing to swap" };

      const now = deps.now();
      const reply = await call("/v0/quote", {
        method: "POST",
        timeoutMs: 15_000,
        body: {
          dry: false,
          depositMode: "SIMPLE",
          swapType: "EXACT_INPUT",
          slippageTolerance: request.maxLossBps,
          originAsset,
          depositType: "ORIGIN_CHAIN",
          destinationAsset,
          amount: request.amountIn.toString(),
          refundTo: request.refundTo,
          refundType: "ORIGIN_CHAIN",
          recipient: request.recipient,
          recipientType: "DESTINATION_CHAIN",
          deadline: new Date(now + QUOTE_DEADLINE_MS).toISOString(),
        },
      });
      if (reply === undefined) return { kind: "unavailable", reason: "NEAR could not be reached" };

      if (!reply.ok) {
        const message = errorReplySchema.safeParse(reply.json);
        const text = message.success ? message.data.message : "no message";
        const tooLow = TOO_LOW.exec(text);
        if (reply.status === 400 && tooLow) return { kind: "too_small", minimumIn: BigInt(tooLow[1]!), reason: text };
        return { kind: "unavailable", reason: `NEAR refused the quote (${reply.status}): ${text}` };
      }

      const parsed = quoteReplySchema.safeParse(reply.json);
      if (!parsed.success) return { kind: "unavailable", reason: "NEAR's quote reply is unreadable" };
      const { depositAddress, depositMemo, deadline, amountIn, amountOut, minAmountOut } = parsed.data.quote;

      if (depositAddress === undefined) return { kind: "unavailable", reason: "NEAR's quote has no deposit address" };
      // Our payouts send to an address only; a deposit that needs a memo would be lost.
      if (depositMemo) return { kind: "unavailable", reason: "NEAR's quote needs a deposit memo" };
      const deadlineAt = Date.parse(deadline ?? "");
      if (!Number.isFinite(deadlineAt) || deadlineAt - now < MIN_SWAP_TIME_LEFT_MS) {
        return { kind: "unavailable", reason: `NEAR's quote deadline (${deadline ?? "missing"}) is missing or too close` };
      }
      // EXACT_INPUT: a smaller deposit is refunded whole, so the quote must be for exactly what we send.
      if (BigInt(amountIn) !== request.amountIn) {
        return { kind: "unavailable", reason: `NEAR quoted amountIn ${amountIn}, not the ${request.amountIn} asked` };
      }

      return {
        kind: "ok",
        quote: {
          provider: "near_intents",
          depositAddress,
          amountIn: BigInt(amountIn),
          amountOut: BigInt(amountOut),
          minAmountOut: BigInt(minAmountOut),
          deadline: deadlineAt,
          record: reply.json,
        },
      };
    },

    async start(deposit) {
      const reply = await call("/v0/deposit/submit", {
        method: "POST",
        timeoutMs: 10_000,
        body: { txHash: deposit.txid, depositAddress: deposit.depositAddress },
      });
      return reply?.ok === true;
    },

    async status({ depositAddress }): Promise<SwapStatus | undefined> {
      const reply = await call(`/v0/status?${new URLSearchParams({ depositAddress })}`, { method: "GET", timeoutMs: 10_000 });
      if (!reply?.ok) {
        if (reply) console.warn("NEAR swap status request failed:", reply.status, depositAddress);
        return undefined;
      }
      const parsed = statusReplySchema.safeParse(reply.json);
      if (!parsed.success) {
        console.warn("NEAR swap status reply is unreadable:", depositAddress);
        return undefined;
      }
      const details = parsed.data.swapDetails;
      const amount = (text: string | null | undefined) => (text == null ? undefined : BigInt(text));
      return {
        status: parsed.data.status,
        ...(details.amountIn != null && { amountIn: amount(details.amountIn) }),
        ...(details.amountOut != null && { amountOut: amount(details.amountOut) }),
        ...(details.refundedAmount != null && { refundedAmount: amount(details.refundedAmount) }),
        ...(details.refundReason != null && { refundReason: details.refundReason }),
        originTxids: details.originChainTxHashes.map((tx) => tx.hash),
        deliveryTxids: details.destinationChainTxHashes.map((tx) => tx.hash),
      };
    },
  };
}

// A note that must survive the swap's later status changes. TON writes it
// when money arrived after the payout was signed and went to the platform
// (see transactions/ton.ts). It always sits at the end of review_reason.
export const LATE_PAYMENT_NOTE_PREFIX = "Late payment:";
