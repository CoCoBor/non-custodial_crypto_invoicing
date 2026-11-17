import { env } from "../config/env.js";
import { Invoice } from "../database/invoices.model.js";
import { updateSwapStatus as updateNearSwapStatus } from "../swap/near.js";
import { transferBtcToMerchant, updateSwapStatus } from "../transactions/btc.js";
import { transferTonToMerchant } from "../transactions/ton.js";
import {
  WATCHED_COINS,
  checkInvoicePayment,
  getPaymentTotals,
  type PaymentCheckPorts,
} from "./invoice.function.js";

export type WatchedInvoice = {
  invoice_id: string;
  user_id: string;
  status?: string | null;
  crypto?: string | null;
  to_crypto?: string | null;
  tx?: { out?: string | null } | null;
  swap?: { deposit_address?: string | null } | null;
};

export type WatcherPorts = PaymentCheckPorts & {
  /** Pays out a confirmed invoice, or follows a payout already under way. */
  payOut: (invoice: WatchedInvoice) => Promise<void>;
};

/** One look at every open invoice. */
export async function runWatcherPass(
  ports: WatcherPorts,
  isStopped: () => boolean = () => false,
): Promise<void> {
  // A merchant's-list invoice has no deposit address until the payer picks
  // a coin, so there is nothing on chain to look at: only the clock.
  const now = ports.now();
  await Invoice.updateMany(
    {
      mode: "merchant_list",
      crypto: "",
      status: "waiting",
      $expr: {
        $lte: [
          { $add: ["$timestamps.waiting", { $multiply: ["$lifetime", 60_000] }] },
          now,
        ],
      },
    },
    { $set: { status: "expired", "timestamps.expired": now } },
  ).exec();

  const invoices = await Invoice.find({
    crypto: { $in: [...WATCHED_COINS] },
    status: {
      $in: ["waiting", "underpaid", "confirming", "confirmed", "processing"],
    },
  })
    .select(
      "invoice_id user_id status crypto to_crypto tx.out swap.deposit_address -_id",
    )
    .lean()
    .exec();

  for (const invoice of invoices) {
    if (isStopped()) break;

    // One invoice failing must not hold up the others.
    try {
      if (invoice.status === "confirmed" || invoice.status === "processing") {
        await ports.payOut(invoice);
        continue;
      }

      const result = await checkInvoicePayment(
        invoice.invoice_id,
        invoice.user_id,
        ports,
      );

      if (result && result.status !== invoice.status)
        console.log("Invoice status changed:", result.invoiceId, result.status);
    } catch (error) {
      console.error("Invoice watcher failed on", invoice.invoice_id, error);
    }
  }
}

async function payOutOnChain(invoice: WatchedInvoice): Promise<void> {
  if (invoice.crypto === "ton") {
    await transferTonToMerchant(invoice.invoice_id, env.platformTonAddress);

    if (invoice.to_crypto !== "ton" && invoice.status === "processing") {
      // Read tx.out again: the call above changes it to the
      // transaction hash when the payout lands.
      const current = await Invoice.findOne({
        invoice_id: invoice.invoice_id,
        status: "processing",
      })
        .select("tx.out swap.deposit_address -_id")
        .lean()
        .exec();
      if (current?.tx?.out && current.swap?.deposit_address) {
        await updateNearSwapStatus(
          invoice.invoice_id,
          current.tx.out,
          current.swap.deposit_address,
        );
      }
    }
    return;
  }

  await transferBtcToMerchant(invoice.invoice_id, env.platformBtcAddress);

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
}

export function startInvoiceWatcher() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentRun: Promise<void> = Promise.resolve();

  const ports: WatcherPorts = {
    now: Date.now,
    getPaymentTotals,
    payOut: payOutOnChain,
  };

  async function checkInvoices(): Promise<void> {
    try {
      await runWatcherPass(ports, () => stopped);
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
