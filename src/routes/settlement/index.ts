import { Router } from "express";

import { bitcoinSettlementRouter } from "./bitcoin.js";

export const settlementRouter = Router();

settlementRouter.use("/bitcoin", bitcoinSettlementRouter);
