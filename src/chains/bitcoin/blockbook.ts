import { z } from "zod";
import { env } from "../../config/env.js";

export interface AddressActivity {
  address: string;
  confirmedSatoshi: number;
  pendingSatoshi: number;
  unconfirmedTxCount: number;
}

const DIGITS = /^\d+$/; // totalReceived can never be negative
const SIGNED_DIGITS = /^-?\d+$/; // unconfirmedBalance can be negative, if the merchant is spending

const payloadSchema = z.object({
  address: z.string().min(1),
  totalReceived: z.string().regex(DIGITS),
  unconfirmedBalance: z.string().regex(SIGNED_DIGITS).optional(),
  unconfirmedTxs: z.number().int().nonnegative(),
});

export function parseAddressActivity(
  payload: unknown,
): AddressActivity | undefined {
  const result = payloadSchema.safeParse(payload);
  if (!result.success) {
    return undefined;
  }

  const { address, totalReceived, unconfirmedBalance, unconfirmedTxs } =
    result.data;

  const confirmedSatoshi = Number(totalReceived);

  if (!Number.isSafeInteger(confirmedSatoshi)) {
    return undefined;
  }

  let pendingSatoshi = 0;

  if (unconfirmedBalance !== undefined) {
    const parsedPending = Number(unconfirmedBalance);

    if (!Number.isSafeInteger(parsedPending)) {
      return undefined;
    }

    pendingSatoshi = Math.max(0, parsedPending);
  }

  return {
    address,
    confirmedSatoshi,
    pendingSatoshi,
    unconfirmedTxCount: unconfirmedTxs,
  };
}

export async function fetchAddressActivity(
  address: string,
): Promise<AddressActivity | undefined> {
  try {
    const url = `https://btcbook.nownodes.io/api/v2/address/${address}?details=txids&pageSize=1`;
    const res = await fetch(url, {
      headers: { "api-key": env.nowNodesApiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return undefined;
    }

    const json = await res.json();
    return parseAddressActivity(json);
  } catch {
    return undefined;
  }
}
