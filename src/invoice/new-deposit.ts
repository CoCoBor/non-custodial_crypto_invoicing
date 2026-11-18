import type { Response } from "express";

import { DepositUnavailableError, type ChainAdapter, type NewDeposit } from "../chains/adapter.js";

/** The chain's new deposit, or why none can be made now (any other error is thrown). */
export async function newDepositOrUnavailable(chain: ChainAdapter): Promise<NewDeposit | DepositUnavailableError> {
  try {
    return await chain.newDeposit();
  } catch (error) {
    if (!(error instanceof DepositUnavailableError)) throw error;
    console.warn(error.message);
    return error;
  }
}

/** The answer when no deposit can be made. The reason (our config) stays in the log. */
export function refuseWithoutDeposit(res: Response, error: DepositUnavailableError) {
  return res.status(503).json({
    error: {
      code: "DEPOSIT_UNAVAILABLE",
      message: `${error.asset} deposits can't be made right now; try again later or pick another coin`,
    },
  });
}
