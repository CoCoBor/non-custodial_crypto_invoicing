import { NextFunction, Request, RequestHandler, Response } from "express";
import { findUserByMerchantKey } from "../auth/user.function.js";

export const requireMerchantKey: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const merchantKey = req.headers["merchant_key"];

  if (merchantKey === "" || typeof merchantKey !== "string") {
    return res.status(401).json({
      error: {
        code: "INVALID_MERCHANT_KEY",
        message: "merchant key is missing or invalid",
      },
    });
  }

  const user = await findUserByMerchantKey(merchantKey);

  if (!user) {
    return res.status(401).json({
      error: {
        code: "INVALID_MERCHANT_KEY",
        message: "merchant key is missing or invalid",
      },
    });
  }

  const { user_id, merchant_fee, payout_addresses } = user;
  req.merchant = {
    user_id,
    merchant_fee,
    payout_addresses,
  };
  next();
};
