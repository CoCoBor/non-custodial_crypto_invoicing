import { env } from "../config/env.js";
import { Invoice } from "../database/invoices.model.js";
import { transferBtcToMerchant, updateSwapStatus } from "../transactions/btc.js";
import { checkInvoicePayment } from "./invoice.function.js";

export function startInvoiceWatcher() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentRun: Promise<void> = Promise.resolve();

  async function checkInvoices(): Promise<void> {
    try {
      const invoices = await Invoice.find({
        crypto: "btc",
        status: {
          $in: [
            "waiting",
            "underpaid",
            "confirming",
            "confirmed",
            "processing",
          ],
        },
      })
        .select(
          "invoice_id user_id status to_crypto tx.out swap.deposit_address -_id",
        )
        .lean()
        .exec();

      for (const invoice of invoices) {
        if (stopped) break;

        if (invoice.status === "confirmed" || invoice.status === "processing") {
          await transferBtcToMerchant(
            invoice.invoice_id,
            env.platformBtcAddress,
          );

          const isSwap = invoice.to_crypto !== "btc";
          if (
            isSwap &&
            invoice.status === "processing" &&
            invoice.tx?.out &&
            invoice.swap?.deposit_address
          ) {
            await updateSwapStatus(
              invoice.invoice_id,
              invoice.tx.out,
              invoice.swap.deposit_address,
            );
          }
          continue;
        }

        const result = await checkInvoicePayment(
          invoice.invoice_id,
          invoice.user_id,
        );

        if (!result) continue;

        if (result && result.status !== invoice.status)
          console.log(
            "Invoice status changed:",
            result.invoiceId,
            result.status,
          );
      }
    } catch (error) {
      console.error("Invoice watcher failed:", error);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          currentRun = checkInvoices();
        }, 15_000);
      }
    }
  }

  currentRun = checkInvoices();

  return async function stopInvoiceWatcher(): Promise<void> {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    await currentRun;
  };
}
