import { z } from "zod";
import { env } from "../config/env.js";
import { Invoice } from "../database/invoices.model.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };

const API_URL = "https://1click.chaindefuser.com";

const swapTokenSchema = z.object({
  assetId: z.string().min(1),
  symbol: z.string().min(1),
  blockchain: z.string().min(1),
  decimals: z.number().int().nonnegative(),
  contractAddress: z.string().optional(),
});

export type SwapToken = z.infer<typeof swapTokenSchema>;

const swapTokensSchema = z.array(swapTokenSchema);

export async function getSwapTokens(): Promise<SwapToken[] | undefined> {
  try {
    const res = await fetch(`${API_URL}/v0/tokens`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error("Swap token request failed: ", res.status);
      return undefined;
    }

    const parsed = swapTokensSchema.safeParse(await res.json());

    if (!parsed.success) {
      console.warn("Invalid swap token response:", parsed.error.message);
      return undefined;
    }

    return parsed.data;
  } catch (error) {
    console.warn(
      "Swap token request failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

const swapQuoteSchema = z.looseObject({
  correlationId: z.string(),
  timestamp: z.string(),
  signature: z.string(),
  quoteRequest: z.looseObject({}),
  quote: z.looseObject({
    amountIn: z.string().regex(/^[0-9]+$/),
    amountInFormatted: z.string(),
    amountOut: z.string().regex(/^[0-9]+$/),
    amountOutFormatted: z.string(),
    minAmountOut: z.string().regex(/^[0-9]+$/),
    timeEstimate: z.number().nonnegative(),
    depositAddress: z.string().min(1).optional(),
    // Some chains need a memo with the deposit. We never send one, so a
    // quote that has one is refused (see prepareSwap).
    depositMemo: z.string().optional(),
    deadline: z.string().min(1).optional(),
  }),
});

export type SwapQuote = z.infer<typeof swapQuoteSchema>["quote"];
export type SwapQuoteResponse = z.infer<typeof swapQuoteSchema>;

export async function getSwapQuote(input: {
  originAsset: string;
  destinationAsset: string;
  amount: bigint;
  recipient: string;
  refundAddress: string;
  dry?: boolean;
}): Promise<SwapQuoteResponse | undefined> {
  const { originAsset, destinationAsset, amount, recipient, refundAddress } =
    input;
  if (amount <= 0n) throw new RangeError("Swap amount must be positive");

  const dry = input.dry ?? true;
  try {
    const res = await fetch(`${API_URL}/v0/quote`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.nearIntentsJwt}`,
      },
      body: JSON.stringify({
        dry,
        depositMode: "SIMPLE",
        swapType: "EXACT_INPUT",
        slippageTolerance: 50,
        originAsset: originAsset,
        destinationAsset: destinationAsset,
        amount: amount.toString(),
        depositType: "ORIGIN_CHAIN",
        recipient: recipient,
        recipientType: "DESTINATION_CHAIN",
        refundTo: refundAddress,
        refundType: "ORIGIN_CHAIN",
        deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn("Swap quote request failed:", res.status, await res.text());
      return undefined;
    }

    const parsed = swapQuoteSchema.safeParse(await res.json());

    if (!parsed.success) {
      console.warn("Invalid swap quote response", parsed.error.message);
      return undefined;
    }

    const result = parsed.data;

    if (!dry && (!result.quote.depositAddress || !result.quote.deadline)) {
      console.warn("Swap quote is missing its deposit address or deadline");
      return undefined;
    }

    return result;
  } catch (error) {
    console.warn(
      "Swap quote request failed:",
      error instanceof Error ? error.message : "unknown error",
    );

    return undefined;
  }
}

const swapStatusSchema = z.object({
  status: z.enum([
    "PENDING_DEPOSIT",
    "KNOWN_DEPOSIT_TX",
    "INCOMPLETE_DEPOSIT",
    "PROCESSING",
    "SUCCESS",
    "REFUNDED",
    "FAILED",
  ]),
  swapDetails: z.object({
    amountIn: z
      .string()
      .regex(/^[0-9]+$/)
      .optional()
      .nullish(),
    amountOut: z
      .string()
      .regex(/^[0-9]+$/)
      .optional()
      .nullish(),
    refundedAmount: z
      .string()
      .regex(/^[0-9]+$/)
      .optional()
      .nullish(),
    refundReason: z.string().optional().nullish(),

    originChainTxHashes: z.array(z.object({ hash: z.string().min(1) })),
    destinationChainTxHashes: z.array(z.object({ hash: z.string().min(1) })),
  }),
});

export type SwapStatusResponse = z.infer<typeof swapStatusSchema>;

export async function getSwapStatus(
  depositAddress: string,
): Promise<SwapStatusResponse | undefined> {
  try {
    const url = new URL(`${API_URL}/v0/status`);
    url.searchParams.set("depositAddress", depositAddress);

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.nearIntentsJwt}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn("Swap status request failed:", res.status, await res.text());
      return undefined;
    }

    const parsed = swapStatusSchema.safeParse(await res.json());

    if (!parsed.success) {
      console.warn("Invalid swap status response", parsed.error.message);
      return undefined;
    }

    return parsed.data;
  } catch (error) {
    console.warn(
      "Swap status request failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

// NEAR's symbol, where it differs from ours. Checked 2026-11-10: NEAR lists
// native Toncoin as "GRAM" (blockchain "ton", 9 decimals, no contract).
// "ton" stays accepted in case NEAR renames it back.
const NEAR_SYMBOLS: Partial<Record<keyof typeof cryptos, string[]>> = {
  ton: ["ton", "gram"],
};

export function findSwapToken(
  cryptoId: keyof typeof cryptos,
  tokens: SwapToken[],
): SwapToken | undefined {
  const crypto = cryptos[cryptoId];

  if (!crypto) return undefined;

  const chain = crypto.chain.symbol;
  const symbols = NEAR_SYMBOLS[cryptoId] ?? [crypto.symbol.toLowerCase()];

  const contractAddress =
    "contract_address" in crypto
      ? crypto.contract_address
      : "mint_address" in crypto
        ? crypto.mint_address
        : undefined;

  const matches = tokens.filter((token) => {
    if (
      token.blockchain !== chain ||
      !symbols.includes(token.symbol.toLowerCase()) ||
      token.decimals !== crypto.decimal
    )
      return false;

    if (!contractAddress) return true;
    if (!token.contractAddress) return false;

    if (chain === "eth" || chain === "bsc")
      return (token.contractAddress.toLowerCase() === contractAddress.toLowerCase());

    return token.contractAddress === contractAddress;
  });

  if(matches.length!==1){
    console.warn("Expected one matching swap token:", cryptoId, matches.length)
    return undefined
  }

  return matches[0]
}

// ---------- Swap flow, shared by every chain ----------
//
// NEAR does the cross-chain work. From a chain's side, a swap is a normal
// payout whose receiver is NEAR's deposit address instead of the merchant.
// So each chain only answers two questions (SwapOrigin below), and the
// quote checks, deadline rules and status tracking live here once.

// Leave at least this long before the NEAR deadline when sending. A deposit
// that arrives after the deadline is refunded, not swapped.
export const MIN_SWAP_TIME_LEFT_MS = 4 * 60 * 60 * 1000;

export type CryptoId = keyof typeof cryptos;

export function isCryptoId(value: string): value is CryptoId {
  return Object.hasOwn(cryptos, value);
}

export function hasSwapTimeLeft(deadline: string | null | undefined): boolean {
  const expiresAt = Date.parse(deadline ?? ""); // NaN if missing or invalid
  return (
    Number.isFinite(expiresAt) && expiresAt - Date.now() >= MIN_SWAP_TIME_LEFT_MS
  );
}

export type SwapOrigin = {
  // The coin we send: "btc", "ltc", "sol", "usdtsol", ...
  crypto: CryptoId;
  isValidAddress(address: string): boolean;
  // How much reaches `address` after the network fee and platform fee, or
  // undefined if it can't be paid right now. Must use the same fees the
  // chain then signs with.
  amountArrivingAt(address: string): Promise<bigint | undefined>;
  // NEAR returns the coin here if the swap fails.
  refundAddress: string;
  // Ours. A deposit address equal to it (or to the refund address) is refused.
  platformAddress: string;
};

export type PreparedSwap = {
  depositAddress: string;
  deadline: string;
  amount: bigint;
  quote: SwapQuoteResponse;
};

async function findSwapAssets(origin: CryptoId, destination: CryptoId) {
  const tokens = await getSwapTokens();
  if (tokens === undefined) return undefined;

  const originAsset = findSwapToken(origin, tokens);
  const destinationAsset = findSwapToken(destination, tokens);
  if (originAsset === undefined || destinationAsset === undefined) {
    console.warn("No NEAR swap token for:", origin, "->", destination);
    return undefined;
  }

  return {
    originAsset: originAsset.assetId,
    destinationAsset: destinationAsset.assetId,
  };
}

// Gets a real quote whose input amount is exactly what the chain will send
// to the quote's deposit address. EXACT_INPUT: if less arrives, NEAR refunds
// all of it. undefined = not ready (NEAR down, quote unusable); retry later.
export async function prepareSwap(
  origin: SwapOrigin,
  toCrypto: CryptoId,
  recipient: string,
): Promise<PreparedSwap | undefined> {
  if (toCrypto === origin.crypto) return undefined;

  const assets = await findSwapAssets(origin.crypto, toCrypto);
  if (assets === undefined) return undefined;

  // The fee can depend on the receiving address (output size on BTC/LTC,
  // a brand-new account on Solana). Size with a stand-in address first,
  // then check again with the real deposit address.
  let amount = await origin.amountArrivingAt(origin.platformAddress);
  if (amount === undefined) return undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await getSwapQuote({
      originAsset: assets.originAsset,
      destinationAsset: assets.destinationAsset,
      amount,
      recipient,
      refundAddress: origin.refundAddress,
      dry: false,
    });
    if (response === undefined) return undefined;

    const { depositAddress, depositMemo, deadline, amountIn } = response.quote;

    if (depositAddress === undefined || !origin.isValidAddress(depositAddress)) {
      console.warn("Swap quote deposit address is invalid:", origin.crypto);
      return undefined;
    }
    if (
      depositAddress === origin.platformAddress ||
      depositAddress === origin.refundAddress
    ) {
      console.warn("Swap quote deposit address is one of ours:", origin.crypto);
      return undefined;
    }
    if (depositMemo) {
      console.warn("Swap quote needs a deposit memo; we never send one:", origin.crypto);
      return undefined;
    }
    if (deadline === undefined || !hasSwapTimeLeft(deadline)) {
      console.warn("Swap quote deadline is invalid or too close:", origin.crypto, deadline);
      return undefined;
    }
    if (BigInt(amountIn) !== amount) {
      console.warn("Swap quote amountIn differs from what we asked:", origin.crypto);
      return undefined;
    }

    const real = await origin.amountArrivingAt(depositAddress);
    if (real === undefined) return undefined;
    if (real === amount) {
      return { depositAddress, deadline, amount, quote: response };
    }

    console.warn("Swap amount changed for the real deposit address; re-quoting:", origin.crypto);
    amount = real;
  }

  console.warn("Could not match the payout to a swap quote:", origin.crypto);
  return undefined;
}

// The swap fields to save together with the signed tx (before sending it).
export function swapFieldsToSave(swap: PreparedSwap) {
  return {
    "swap.deposit_address": swap.depositAddress,
    "swap.deadline": swap.deadline,
    "swap.status": "PENDING_DEPOSIT",
    "swap.quote_response": swap.quote,
  };
}

// A note that must survive the swap's later status changes. TON writes it
// when money arrived after the payout was signed and went to the platform
// (see transactions/ton.ts). It always sits at the end of review_reason.
export const LATE_PAYMENT_NOTE_PREFIX = "Late payment:";

// For the watcher: call for a processing invoice that has a swap.
// SUCCESS completes the invoice; REFUNDED / FAILED mark it failed with a note.
// The same for every chain.
export async function updateSwapStatus(
  invoiceId: string,
  txId: string,
  depositAddress: string,
) {
  const filter = {
    invoice_id: invoiceId,
    status: "processing" as const,
    "tx.out": txId,
    "swap.deposit_address": depositAddress,
  };

  const invoice = await Invoice.findOne(filter)
    .select("crypto address review_reason +swap.quote_response")
    .exec();
  if (!invoice) return;

  const swapStatus = await getSwapStatus(depositAddress);
  if (swapStatus === undefined) return;

  const coin = invoice.crypto.toUpperCase();
  const reason = swapStatus.swapDetails.refundReason ?? "no reason given";
  // Where NEAR sends refunds: the refundTo we quoted with (NEAR echoes the
  // request in the quote). The deposit address for most coins, the platform
  // address for TON.
  const savedRequest = z
    .object({ quoteRequest: z.object({ refundTo: z.string().min(1) }) })
    .safeParse(invoice.swap?.quote_response);
  const refundPlace = savedRequest.success
    ? savedRequest.data.quoteRequest.refundTo
    : `the refundTo in the saved quote (unreadable; the deposit address is ${invoice.address})`;
  // Keep a late-payment note (if any) on every note written below.
  const current = invoice.review_reason ?? "";
  const lateAt = current.indexOf(LATE_PAYMENT_NOTE_PREFIX);
  const lateNote = lateAt >= 0 ? current.slice(lateAt) : "";
  const note = (text: string) => [text, lateNote].filter(Boolean).join(" ");
  let changes: Record<string, unknown>;

  switch (swapStatus.status) {
    case "PENDING_DEPOSIT":
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      changes = { "swap.status": swapStatus.status };
      break;

    case "SUCCESS": {
      const savedQuote = z
        .object({
          quote: z.object({ minAmountOut: z.string().regex(/^[0-9]+$/) }),
        })
        .safeParse(invoice.swap?.quote_response);
      const { amountOut, destinationChainTxHashes } = swapStatus.swapDetails;

      let problem: string | undefined;
      if (!savedQuote.success) {
        problem = "NEAR reported SUCCESS, but the saved quote is unreadable; check minAmountOut manually";
      } else if (amountOut == null) {
        problem = "NEAR reported SUCCESS without amountOut";
      } else if (destinationChainTxHashes.length < 1) {
        problem = "NEAR reported SUCCESS without a destination tx";
      } else if (BigInt(amountOut) < BigInt(savedQuote.data.quote.minAmountOut)) {
        problem = "NEAR reported SUCCESS, but amountOut is below the quote's minAmountOut";
      }

      if (problem !== undefined || amountOut == null) {
        changes = { "swap.status": swapStatus.status, review_reason: note(problem ?? "") };
        break;
      }

      changes = {
        "swap.status": swapStatus.status,
        status: "completed",
        received_amount: amountOut,
        "swap.destination_txids": destinationChainTxHashes.map((tx) => tx.hash),
        "timestamps.completed": Date.now(),
        review_reason: note(""),
      };
      break;
    }

    case "REFUNDED":
      changes = {
        "swap.status": swapStatus.status,
        status: "failed",
        "swap.refunded_amount": swapStatus.swapDetails.refundedAmount ?? "0",
        review_reason: note(`Swap refunded: NEAR sent the ${coin} back to ${refundPlace}. Pay the merchant manually. NEAR says: ${reason}`),
        "timestamps.failed": Date.now(),
      };
      break;

    case "FAILED":
      changes = {
        "swap.status": swapStatus.status,
        status: "failed",
        review_reason: note(`Swap failed; check NEAR and the funds (refunds go to ${refundPlace}). NEAR says: ${reason}`),
        "timestamps.failed": Date.now(),
      };
      break;

    case "INCOMPLETE_DEPOSIT":
      changes = {
        "swap.status": swapStatus.status,
        review_reason: note("NEAR received less than quoted; investigate"),
      };
      break;

    default:
      return;
  }

  const result = await Invoice.updateOne(filter, { $set: changes }).exec();
  if (result.modifiedCount > 0 && changes.status !== undefined) {
    console.log("Swap finished:", invoiceId, swapStatus.status);
  }
}