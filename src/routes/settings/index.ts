import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { ASSET_IDS, checkPayoutAddress } from "../../assets/payout-address.js";
import { confirmTotpCode } from "../../auth/totp-step-up.js";
import { User } from "../../database/users.model.js";
import { requireSession } from "../../middleware/require-session.js";
import { percentToBasisPoints } from "../../money/percent.js";

export const settingsRouter = Router();

settingsRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
settingsRouter.use(requireSession);

const MIN_SWAP_MAX_LOSS_PERCENT = 0.5;
const MAX_SWAP_MAX_LOSS_PERCENT = 5;

function invalidRequest(res: Response) {
  return res.status(400).json({
    error: { code: "INVALID_REQUEST", message: "request body is invalid" },
  });
}

settingsRouter.get("/", async (req, res) => {
  const user = await User.findOne({ user_id: req.session!.userId }).lean().exec();
  if (!user) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }

  return res.status(200).json({
    data: {
      feeRate: user.merchant_fee,
      swapMaxLossPercent: user.swap_max_loss_bps / 100,
      webhookUrl: user.webhook_url,
      payoutAddresses: user.payout_addresses,
      refundAddresses: user.refund_addresses,
    },
  });
});

const addressSchema = z.object({
  asset: z.enum(ASSET_IDS),
  address: z.string().trim().max(200),
  totpCode: z.unknown().optional(),
});

function saveAddress(field: "payout_addresses" | "refund_addresses") {
  return async (req: Request, res: Response) => {
    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res);
    const { asset, address, totpCode } = parsed.data;

    // An empty address clears it; anything else must be valid for the coin's chain.
    if (address !== "") {
      const check = checkPayoutAddress(asset, address);
      if (check === "unsupported") {
        return res.status(409).json({
          error: {
            code: "PAYOUT_NOT_SUPPORTED",
            message: `${asset} payouts are not supported yet`,
          },
        });
      }
      if (check === "invalid") {
        return res.status(409).json({
          error: {
            code: "ADDRESS_INVALID",
            message: `this is not a valid ${asset} address`,
          },
        });
      }
    }

    const userId = req.session!.userId;
    if (!(await confirmTotpCode(userId, totpCode, res))) return;

    await User.updateOne(
      { user_id: userId },
      { $set: { [`${field}.${asset}`]: address } },
    ).exec();
    return res.status(200).json({ data: { asset, address } });
  };
}

settingsRouter.patch("/payout-addresses", saveAddress("payout_addresses"));
settingsRouter.patch("/refund-addresses", saveAddress("refund_addresses"));

const swapMaxLossSchema = z.object({ percent: z.number() });

settingsRouter.patch("/swap-max-loss", async (req, res) => {
  const parsed = swapMaxLossSchema.safeParse(req.body);
  const basisPoints = parsed.success
    ? percentToBasisPoints(
        parsed.data.percent,
        MIN_SWAP_MAX_LOSS_PERCENT,
        MAX_SWAP_MAX_LOSS_PERCENT,
      )
    : undefined;
  if (basisPoints === undefined) return invalidRequest(res);

  await User.updateOne(
    { user_id: req.session!.userId },
    { $set: { swap_max_loss_bps: Number(basisPoints) } },
  ).exec();
  return res.status(200).json({ data: { swapMaxLossPercent: Number(basisPoints) / 100 } });
});

const webhookSchema = z.object({
  url: z.string().max(2000),
  totpCode: z.unknown().optional(),
});

// Payment notifications carry order data: only to an https address, and
// never with credentials in the URL.
function isAcceptableWebhookUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

settingsRouter.patch("/webhook-url", async (req, res) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) return invalidRequest(res);
  const { url, totpCode } = parsed.data;
  if (url !== "" && !isAcceptableWebhookUrl(url)) return invalidRequest(res);

  const userId = req.session!.userId;
  if (!(await confirmTotpCode(userId, totpCode, res))) return;

  await User.updateOne({ user_id: userId }, { $set: { webhook_url: url } }).exec();
  return res.status(200).json({ data: { webhookUrl: url } });
});
