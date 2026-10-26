import { z } from "zod";
import { env } from "../config/env.js";
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

export function findSwapToken(
  cryptoId: keyof typeof cryptos,
  tokens: SwapToken[],
): SwapToken | undefined {
  const crypto = cryptos[cryptoId];

  if (!crypto) return undefined;

  const chain = crypto.chain.symbol;

  const contractAddress =
    "contract_address" in crypto
      ? crypto.contract_address
      : "mint_address" in crypto
        ? crypto.mint_address
        : undefined;

  const matches = tokens.filter((token) => {
    if (
      token.blockchain !== chain ||
      token.symbol.toLowerCase() !== crypto.symbol.toLowerCase() ||
      token.decimals !== crypto.decimal
    )
      return false;

    if (!contractAddress) return true;
    if (!token.contractAddress) return false;

    if (chain === "eth" || chain === "bcs")
      return (token.contractAddress.toLowerCase() === contractAddress.toLowerCase());

    return token.contractAddress === contractAddress;
  });

  if(matches.length!==1){
    console.warn("Expected one matching swap token:", cryptoId, matches.length)
    return undefined
  }

  return matches[0]
}
