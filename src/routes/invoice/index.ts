import { Router } from "express";

import { createInvoiceRouter } from "./create.js";
import { invoiceStatusRouter } from "./status.js";

export const invoiceRouter = Router();

invoiceRouter.use(createInvoiceRouter);
invoiceRouter.use(invoiceStatusRouter);
