import type { AssetId } from "../../src/assets/payout-address.js";
import type { QuoteAnswer, SwapPort, SwapRequest, SwapStatus } from "../../src/swap/swap-port.js";

/** A swap port that must not be used: for passes over invoices with no swap. */
export function unusedSwap(): SwapPort {
  const never = async (): Promise<never> => {
    throw new Error("this test makes no swap");
  };
  return { provider: "near_intents", supports: () => true, quote: never, start: never, status: never };
}

/**
 * A swap provider for tests. Each quote opens deposit address
 * `swap-deposit-<n>` for exactly the amount asked, unless `answer` says
 * otherwise. Statuses are set per deposit address with `setStatus`.
 */
export function fakeSwap(options: { now: () => number; answer?: (request: SwapRequest) => QuoteAnswer | undefined }) {
  const quotes: SwapRequest[] = [];
  const starts: { depositAddress: string; txid: string }[] = [];
  const statuses = new Map<string, SwapStatus | "lookup fails">();
  let counter = 0;

  const port: SwapPort = {
    provider: "near_intents",
    supports: (from: AssetId, to: AssetId) => from !== to && from !== "xmr" && to !== "xmr",
    quote: async (request) => {
      quotes.push(request);
      const custom = options.answer?.(request);
      if (custom) return custom;
      counter += 1;
      return {
        kind: "ok",
        quote: {
          provider: "near_intents",
          depositAddress: `swap-deposit-${counter}`,
          amountIn: request.amountIn,
          amountOut: request.amountIn * 7n,
          minAmountOut: request.amountIn * 6n,
          deadline: options.now() + 24 * 60 * 60 * 1000,
          record: { quoteRequest: { refundTo: request.refundTo }, quote: { amountIn: request.amountIn.toString() } },
        },
      };
    },
    start: async (deposit) => {
      starts.push(deposit);
      return true;
    },
    status: async (depositAddress) => {
      const status = statuses.get(depositAddress);
      if (status === "lookup fails") return undefined;
      return status ?? { status: "PENDING_DEPOSIT", originTxids: [], deliveryTxids: [] };
    },
  };

  return {
    port,
    quotes,
    starts,
    setStatus(depositAddress: string, status: Partial<SwapStatus> & Pick<SwapStatus, "status"> | "lookup fails") {
      statuses.set(
        depositAddress,
        status === "lookup fails" ? status : { originTxids: [], deliveryTxids: [], ...status },
      );
    },
  };
}
