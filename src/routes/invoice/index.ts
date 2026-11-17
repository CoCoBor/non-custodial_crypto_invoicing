import { Router } from "express";

import type { AppDeps } from "../../app.js";
import { createInvoiceRouter } from "./create.js";
import { invoiceStatusRouter } from "./status.js";

export function createInvoiceRouters(deps: AppDeps) {
  const invoiceRouter = Router();

  invoiceRouter.use(createInvoiceRouter(deps));
  invoiceRouter.use(invoiceStatusRouter);

  return invoiceRouter;
}
