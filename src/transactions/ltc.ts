import litecore from "bitcore-lib-ltc";
import { z } from "zod";
import { env } from "../config/env.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "../money/format.js";
import { parseFeeRate, splitPayout } from "../money/payout-split.js";
import { openSecret } from "../security/secret-envelope.js";
import {
  hasSwapTimeLeft,
  isCryptoId,
  prepareSwap,
  swapFieldsToSave,
  type PreparedSwap,
} from "../swap/near.js";

// Litecoin: payment lookup and LTC -> LTC payout.
// Chain data comes from NOWNodes Blockbook, the same API as btc.ts.

const LTC_BLOCKBOOK_URL = "https://ltcbook.nownodes.io/api/v2";
const LTC_NETWORK = litecore.Networks.livenet;

// 1 LTC = 100,000,000 litoshi (8 decimals, like BTC satoshis).
const LTC_DECIMALS = 8;

// Coinbase (mining reward) outputs can't be spent until 100 blocks deep.
const COINBASE_MATURITY = 100;

// Litecoin Core relay policy, in litoshi per 1000 bytes
// (DEFAULT_MIN_RELAY_TX_FEE in validation.h, DUST_RELAY_TX_FEE in policy/policy.h).
// Nodes reject a tx that pays less than MIN_RELAY, and an output worth less
// than its dust threshold. Litecoin's dust fee is 10x Bitcoin's.
const MIN_RELAY_FEE_PER_KB = 1_000n;
const DUST_RELAY_FEE_PER_KB = 30_000n;

// Sanity cap: 1,000 litoshi per byte, far above normal Litecoin fees.
// A higher estimate means the API is broken; wait instead of paying it.
const MAX_FEE_PER_KB = 1_000_000n;

// Signed P2PKH input: outpoint 36 + script length 1 + script up to 107 + sequence 4.
const P2PKH_INPUT_SIZE = 148;
// Spending size Litecoin Core assumes when it computes an output's dust threshold.
const P2PKH_SPEND_SIZE = 148;
const WITNESS_SPEND_SIZE = 67;

// Merchant fee rates have 8 decimals: "0.005" = 0.5% = 500,000 / 10^8.
const FEE_RATE_DECIMALS = 8;
const FEE_RATE_SCALE = 10n ** BigInt(FEE_RATE_DECIMALS);

const STUCK_TX_REVIEW_MS = 24 * 60 * 60 * 1000;

const txIdSchema = z.string().regex(/^[0-9a-fA-F]{64}$/);
const litoshiString = z.string().regex(/^[0-9]+$/); // digits only, so BigInt() can't throw

const ltcPaymentsSchema = z
  .object({
    totalPages: z.number().int().nonnegative(),
    txs: z.number().int().nonnegative(),
    unconfirmedTxs: z.number().int().nonnegative(),
    transactions: z
      .array(
        z.object({
          txid: txIdSchema,
          confirmations: z.number().int().nonnegative(),
          vout: z.array(
            z.object({
              value: litoshiString,
              isAddress: z.boolean().optional(),
              addresses: z.array(z.string()).optional(),
            }),
          ),
        }),
      )
      .default([]),
  })
  .refine(
    (data) =>
      data.transactions.length > 0 ||
      (data.txs === 0 && data.unconfirmedTxs === 0),
    { message: "Transaction details are missing" },
  );

// ---------- Blockbook API ----------

async function get(path: string): Promise<unknown> {
  try {
    const res = await fetch(`${LTC_BLOCKBOOK_URL}${path}`, {
      headers: {
        "api-key": env.nowNodesApiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      // A redirect would carry the api-key header to another host.
      redirect: "error",
    });

    if (!res.ok) {
      // e.g. 400 {"error":"..."}. Blockbook errors are safe to log.
      console.warn(
        "LTC Blockbook GET failed:",
        path,
        res.status,
        (await res.text()).slice(0, 300),
      );
      return undefined;
    }

    return await res.json();
  } catch (error) {
    console.warn(
      "LTC Blockbook GET failed:",
      path,
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

// Only used for /sendtx/. Never log `body`: it is the signed transaction.
async function post(path: string, body: string): Promise<unknown> {
  try {
    const res = await fetch(`${LTC_BLOCKBOOK_URL}${path}`, {
      method: "POST",
      headers: {
        "api-key": env.nowNodesApiKey,
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      body,
    });

    if (!res.ok) {
      // e.g. 400 {"error":"-26: txn-mempool-conflict"}. Worth seeing, and safe to log.
      console.warn(
        "LTC Blockbook POST failed:",
        path,
        res.status,
        (await res.text()).slice(0, 300),
      );
      return undefined;
    }

    return await res.json();
  } catch (error) {
    console.warn(
      "LTC Blockbook POST failed:",
      path,
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

// Spendable outputs at `address`, in litoshi. Unconfirmed and immature
// coinbase outputs are left out, because spending them can fail.
async function getLtcUtxos(address: string) {
  const parsed = z
    .array(
      z.object({
        txid: txIdSchema,
        vout: z.number().int().nonnegative(),
        value: litoshiString,
        confirmations: z.number().int().nonnegative(),
        coinbase: z.boolean().optional(),
      }),
    )
    .safeParse(await get(`/utxo/${encodeURIComponent(address)}?confirmed=true`));

  if (!parsed.success) return undefined;

  return parsed.data
    .filter((u) => u.confirmations >= (u.coinbase ? COINBASE_MATURITY : 1))
    .map((u) => ({
      txid: u.txid.toLowerCase(),
      vout: u.vout,
      amount: BigInt(u.value),
    }));
}

// Fee rate to pay, in litoshi per kB (1000 bytes), aiming for ~2 blocks.
// Blockbook answers in LTC per kB, e.g. "0.00000997".
async function getLtcFeePerKb() {
  const parsed = z
    .object({ result: z.string() })
    .safeParse(await get("/estimatefee/2"));

  if (!parsed.success) return undefined;

  // "-1" (no estimate yet) fails to parse and becomes undefined.
  const estimate = decimalStrToBigInt(parsed.data.result, LTC_DECIMALS);
  if (estimate === undefined || estimate <= 0n) return undefined;

  if (estimate > MAX_FEE_PER_KB) {
    console.warn("LTC fee estimate is above the sanity cap:", estimate);
    return undefined;
  }

  // The estimate can be below what nodes accept (seen: 997 < 1000).
  return estimate < MIN_RELAY_FEE_PER_KB ? MIN_RELAY_FEE_PER_KB : estimate;
}

// 0 = in the mempool, not mined yet.
// undefined = not found OR lookup failed. Rebroadcasting the same signed tx
// is safe either way: it has the same txid and can only be mined once.
async function getLtcConfirmations(txId: string) {
  if (!txIdSchema.safeParse(txId).success) return undefined;

  const parsed = z
    .object({
      txid: txIdSchema,
      confirmations: z.number().int().nonnegative(),
    })
    .safeParse(await get(`/tx/${txId}`));

  if (!parsed.success) return undefined;
  if (parsed.data.txid.toLowerCase() !== txId.toLowerCase()) return undefined;

  return parsed.data.confirmations;
}

// Sends a signed transaction (hex). Returns its txid in lowercase.
async function broadcastLtcTx(hex: string) {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return undefined;

  const parsed = z
    .object({ result: txIdSchema })
    .safeParse(await post("/sendtx/", hex));

  return parsed.success ? parsed.data.result.toLowerCase() : undefined;
}

// Every transaction that paid `address`, with how much it paid (litoshi).
// Same logic as getBtcPayments in invoice.function.ts.
export async function getLtcPayments(address: string) {
  const payments: { txid: string; amount: bigint; confirmations: number }[] =
    [];
  const seenTxids = new Set<string>();
  let page = 1;

  while (true) {
    const parsed = ltcPaymentsSchema.safeParse(
      await get(
        `/address/${encodeURIComponent(address)}` +
          `?details=txs&page=${page}&pageSize=100`,
      ),
    );
    if (!parsed.success) return undefined;

    for (const transaction of parsed.data.transactions) {
      const txid = transaction.txid.toLowerCase();
      // A new tx can push older ones onto the next page, so skip repeats.
      if (seenTxids.has(txid)) continue;
      seenTxids.add(txid);

      let amount = 0n;
      for (const output of transaction.vout) {
        if (output.isAddress && output.addresses?.includes(address)) {
          amount += BigInt(output.value);
        }
      }

      if (amount > 0n) {
        payments.push({
          txid,
          amount,
          confirmations: transaction.confirmations,
        });
      }
    }

    if (page >= parsed.data.totalPages) break;
    page += 1;
  }

  return payments;
}

// ---------- Payout math (pure: no network, no database) ----------

// Mainnet L..., M... and ltc1... addresses. MWEB (ltcmweb1...) is rejected:
// a normal transaction can't pay it.
export function isValidLtcAddress(address: string): boolean {
  return litecore.Address.isValid(address, LTC_NETWORK);
}

// Bytes a count takes in a transaction (Bitcoin's CompactSize).
function varIntSize(count: number): number {
  if (count < 0xfd) return 1;
  if (count <= 0xffff) return 3;
  return 5;
}

// Size in bytes of an output paying `address`: value 8 + script length + script.
function outputSize(address: string): number {
  const scriptLength = litecore.Script.fromAddress(address).toBuffer().length;
  return 8 + varIntSize(scriptLength) + scriptLength;
}

// Upper estimate of the signed size, for P2PKH deposit inputs.
// The real size can be up to ~2 bytes smaller per input (shorter signatures).
function estimateLtcTxSize(
  inputCount: number,
  outputAddresses: string[],
): number | undefined {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) {
    throw new RangeError("inputCount must be a positive integer");
  }
  if (outputAddresses.length === 0) {
    throw new RangeError("A transaction needs at least one output");
  }

  // version 4 + locktime 4 + input count + output count
  let size =
    8 +
    varIntSize(inputCount) +
    varIntSize(outputAddresses.length) +
    P2PKH_INPUT_SIZE * inputCount;

  for (const address of outputAddresses) {
    if (!isValidLtcAddress(address)) return undefined;
    size += outputSize(address);
  }

  return size;
}

// Smallest amount nodes relay to `address`, as Litecoin Core computes it:
// (output size + size of spending it later) x dust relay fee.
function getLtcDustLimit(address: string): bigint | undefined {
  if (!isValidLtcAddress(address)) return undefined;

  const spendSize = litecore.Script.fromAddress(address).isWitnessProgram()
    ? WITNESS_SPEND_SIZE
    : P2PKH_SPEND_SIZE;

  return (
    (BigInt(outputSize(address) + spendSize) * DUST_RELAY_FEE_PER_KB) / 1000n
  );
}

function calculateLtcPayout(
  total: bigint,
  txSize: number,
  feePerKb: bigint,
  feeRate: bigint,
): { networkFee: bigint; platformFee: bigint; merchantAmount: bigint } | undefined {
  if (!Number.isSafeInteger(txSize) || txSize < 1) {
    throw new RangeError("txSize must be a positive integer");
  }
  if (feePerKb <= 0n) throw new RangeError("feePerKb must be positive");
  if (total < 0n) throw new RangeError("total must not be negative");
  if (feeRate < 0n || feeRate >= FEE_RATE_SCALE) {
    throw new RangeError("feeRate must be at least 0 and below 100%");
  }

  const networkFee = ceilDivide(BigInt(txSize) * feePerKb, 1000n);
  const split = splitPayout({ received: total, networkCost: networkFee, feeRate });
  if (split === undefined || split.merchantAmount <= 0n) return undefined;

  return { networkFee, ...split };
}

// One tx: merchant output, plus a platform output when the fee isn't dust.
// A dust platform fee is dropped and the merchant gets it (same as BTC).
// undefined = too small to pay out right now.
function prepareLtcPayout(input: {
  platformAddress: string;
  merchantAddress: string;
  feePerKb: bigint;
  feeRate: bigint;
  utxos: { txid: string; vout: number; amount: bigint }[];
}):
  | {
      networkFee: bigint;
      platformFee: bigint;
      merchantAmount: bigint;
      txSize: number;
      outputs: { address: string; amount: bigint }[];
    }
  | undefined {
  const { platformAddress, merchantAddress, feePerKb, feeRate, utxos } = input;
  if (utxos.length === 0) return undefined;

  const total = utxos.reduce((sum, u) => sum + u.amount, 0n);

  const payoutFor = (outputAddresses: string[], rate: bigint) => {
    const txSize = estimateLtcTxSize(utxos.length, outputAddresses);
    if (txSize === undefined) return undefined;
    const payout = calculateLtcPayout(total, txSize, feePerKb, rate);
    if (payout === undefined) return undefined;
    return { ...payout, txSize };
  };

  const merchantDust = getLtcDustLimit(merchantAddress);
  const platformDust = getLtcDustLimit(platformAddress);
  if (merchantDust === undefined || platformDust === undefined) return undefined;

  const withPlatform = payoutFor([merchantAddress, platformAddress], feeRate);
  if (withPlatform === undefined) return undefined;

  const payout =
    withPlatform.platformFee >= platformDust
      ? withPlatform
      : payoutFor([merchantAddress], 0n);
  if (payout === undefined) return undefined;

  if (payout.merchantAmount < merchantDust) return undefined;

  const outputs = [{ address: merchantAddress, amount: payout.merchantAmount }];
  if (payout.platformFee > 0n) {
    outputs.push({ address: platformAddress, amount: payout.platformFee });
  }

  return { ...payout, outputs };
}

function litoshiToNumber(litoshi: bigint): number {
  if (litoshi < 0n || litoshi > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Litoshi amount is outside the safe integer range");
  }
  return Number(litoshi);
}

// Signs the payout. Throws if anything doesn't match what was planned.
function signLtcTransaction(input: {
  depositAddress: string;
  wif: string;
  utxos: { txid: string; vout: number; amount: bigint }[];
  outputs: { address: string; amount: bigint }[];
  networkFee: bigint;
  feePerKb: bigint;
  estimatedSize: number;
}): { txid: string; hex: string } {
  const { depositAddress, utxos, outputs, networkFee, feePerKb, estimatedSize } =
    input;

  const inputAmount = utxos.reduce((sum, u) => sum + u.amount, 0n);
  const outputAmount = outputs.reduce((sum, o) => sum + o.amount, 0n);
  if (inputAmount - outputAmount !== networkFee) {
    throw new Error(
      `Inputs ${inputAmount} - outputs ${outputAmount} ≠ fee ${networkFee}`,
    );
  }

  const privateKey = new litecore.PrivateKey(input.wif, LTC_NETWORK);
  if (privateKey.toAddress().toString() !== depositAddress) {
    throw new Error("Deposit key does not match the deposit address");
  }

  const sourceScript = litecore.Script.fromAddress(depositAddress);

  const tx = new litecore.Transaction().from(
    utxos.map(
      (u) =>
        new litecore.Transaction.UnspentOutput({
          txId: u.txid,
          outputIndex: u.vout,
          script: sourceScript,
          satoshis: litoshiToNumber(u.amount),
        }),
    ),
  );

  if (tx.inputs.length !== utxos.length) {
    throw new Error("Duplicate UTXOs: bitcore dropped some inputs");
  }

  for (const o of outputs) tx.to(o.address, litoshiToNumber(o.amount));

  if (tx.outputs.length !== outputs.length) {
    throw new Error("Signed tx has a different number of outputs than planned");
  }

  tx.feePerKb(litoshiToNumber(feePerKb));
  tx.fee(litoshiToNumber(networkFee));
  tx.sign(privateKey);

  // Our own dust check (getLtcDustLimit) already ran; bitcore's only knows P2PKH.
  const hex = tx.serialize({ disableDustOutputs: true });

  const actualSize = hex.length / 2;
  if (actualSize > estimatedSize || estimatedSize - actualSize > utxos.length * 2) {
    throw new Error(
      `Signed size ${actualSize} doesn't match the estimate ${estimatedSize}`,
    );
  }

  return { txid: tx.id.toLowerCase(), hex };
}

// ---------- Payout flow ----------

// Called every watcher round for an LTC invoice that is confirmed or processing.
// confirmed: plan, sign, save the signed tx (status -> processing).
// processing: broadcast until it confirms, then status -> completed.
export async function transferLtcToMerchant(
  invoiceId: string,
  platformAddress: string,
) {
  try {
    let invoice = await Invoice.findOne({
      invoice_id: invoiceId,
      crypto: "ltc",
      status: { $in: ["confirmed", "processing"] },
    })
      .select("+private.private_key +tx.raw")
      .exec();
    if (!invoice) return;

    async function fail(reason: string) {
      const result = await Invoice.updateOne(
        { invoice_id: invoiceId, crypto: "ltc", status: "confirmed" },
        {
          $set: {
            status: "failed",
            "timestamps.failed": Date.now(),
            review_reason: reason,
          },
        },
      ).exec();

      if (result.matchedCount === 0) {
        console.warn(
          "LTC payout: could not mark failed, invoice is no longer confirmed:",
          invoiceId,
          reason,
        );
        return;
      }
      console.error("LTC payout failed:", invoiceId, reason);
    }

    if (invoice.status === "confirmed") {
      const depositAddress = invoice.address;
      const merchantAddress = invoice.to_address;

      // Our own config, not the invoice: never fail an invoice for it.
      if (!isValidLtcAddress(platformAddress)) {
        throw new Error("Platform LTC address is not a valid Litecoin address");
      }

      if (invoice.fee_paid_by_payer) {
        return await fail(
          `Payout stopped: payer-paid fees are not supported for LTC yet. All funds are still at deposit address ${depositAddress}. Pay out manually.`,
        );
      }

      const toCrypto = invoice.to_crypto;
      if (!isCryptoId(toCrypto)) {
        return await fail(
          `Payout stopped: payout asset "${toCrypto}" is unknown. All funds are still at deposit address ${depositAddress}. Fix to_crypto, then pay out manually.`,
        );
      }
      // Paid in LTC but wanted in another coin: swap through NEAR.
      const swapTo = toCrypto === "ltc" ? undefined : toCrypto;

      if (
        !isValidLtcAddress(depositAddress) ||
        new litecore.Address(depositAddress, LTC_NETWORK).type !== "pubkeyhash"
      ) {
        return await fail(
          `Payout stopped: deposit address "${depositAddress}" is not a mainnet P2PKH (L...) address, and the fee math only fits that type. Check how this invoice was created before moving the funds.`,
        );
      }

      // With a swap, the merchant address is on the other chain; NEAR
      // checks it when quoting.
      if (swapTo === undefined) {
        if (!isValidLtcAddress(merchantAddress)) {
          return await fail(
            `Payout stopped: merchant payout address "${merchantAddress}" is not a valid Litecoin address (MWEB "ltcmweb1" addresses are not supported). All funds are still at deposit address ${depositAddress}. Fix the merchant's LTC address, then pay out manually.`,
          );
        }

        if (merchantAddress === depositAddress) {
          return await fail(
            `Payout stopped: merchant payout address is the deposit address itself (${depositAddress}). All funds are still there. Fix the merchant's LTC address, then pay out manually.`,
          );
        }
      }

      const user = await User.findOne({ user_id: invoice.user_id })
        .select("merchant_fee")
        .exec();
      if (!user) {
        return await fail(
          `Payout stopped: merchant account ${invoice.user_id} was not found. All funds are still at deposit address ${depositAddress}. Check whether the merchant was deleted, then pay out manually.`,
        );
      }

      const feeRate = parseFeeRate(user.merchant_fee);
      if (feeRate === undefined) {
        return await fail(
          `Payout stopped: merchant fee rate "${user.merchant_fee}" is not a valid rate below 100%. All funds are still at deposit address ${depositAddress}. Fix merchant_fee (e.g. "0.005" = 0.5%), then pay out manually.`,
        );
      }

      if (!invoice.private?.private_key) {
        return await fail(
          `Payout stopped: the deposit private key is missing from the database. All funds are still at deposit address ${depositAddress}. Restore the key from backup; without it the funds cannot be moved.`,
        );
      }

      const feePerKb = await getLtcFeePerKb();
      if (feePerKb === undefined) {
        console.warn("LTC fee rate unavailable; will retry:", invoiceId);
        return;
      }

      const utxos = await getLtcUtxos(depositAddress);
      if (utxos === undefined) {
        console.warn("LTC UTXOs unavailable; will retry:", invoiceId);
        return;
      }

      const total = utxos.reduce((sum, u) => sum + u.amount, 0n);
      if (total < BigInt(invoice.amount)) {
        // Blockbook can lag behind the payment check; try again next round.
        console.warn(
          "Spendable LTC is below the invoice amount; will retry:",
          invoiceId,
        );
        return;
      }

      // A swap is a normal payout whose receiver is NEAR's deposit address.
      let receiver = merchantAddress;
      let swap: PreparedSwap | undefined;
      if (swapTo !== undefined) {
        swap = await prepareSwap(
          {
            crypto: "ltc",
            isValidAddress: isValidLtcAddress,
            amountArrivingAt: async (address) =>
              prepareLtcPayout({
                platformAddress,
                merchantAddress: address,
                feePerKb,
                feeRate,
                utxos,
              })?.merchantAmount,
            refundAddress: depositAddress,
            platformAddress,
          },
          swapTo,
          merchantAddress,
        );
        if (swap === undefined) {
          console.warn("LTC swap quote not ready; will retry:", invoiceId);
          return;
        }
        receiver = swap.depositAddress;
      }

      const payout = prepareLtcPayout({
        platformAddress,
        merchantAddress: receiver,
        feePerKb,
        feeRate,
        utxos,
      });
      if (payout === undefined) {
        console.warn("LTC payout is too small after fees; will retry:", invoiceId);
        return;
      }

      // NEAR refunds everything if less than amountIn arrives.
      if (swap !== undefined && payout.merchantAmount !== swap.amount) {
        console.warn("LTC payout no longer matches the swap quote; will retry:", invoiceId);
        return;
      }

      let signed: { txid: string; hex: string };
      try {
        signed = signLtcTransaction({
          depositAddress,
          wif: openSecret("litecoin-deposit-key", invoice.private.private_key),
          utxos,
          outputs: payout.outputs,
          networkFee: payout.networkFee,
          feePerKb,
          estimatedSize: payout.txSize,
        });
      } catch (error) {
        return await fail(
          `Payout stopped: signing failed (${error instanceof Error ? error.message : "unknown error"}). Nothing was sent; all funds are still at deposit address ${depositAddress}. Investigate before retrying.`,
        );
      }

      // Save the signed tx before broadcasting it, so a crash can't lose it.
      invoice = await Invoice.findOneAndUpdate(
        { invoice_id: invoiceId, crypto: "ltc", status: "confirmed" },
        {
          $set: {
            status: "processing",
            "timestamps.processing": Date.now(),
            "tx.out": signed.txid,
            "tx.raw": signed.hex,
            // Swap: what the merchant gets is known only when NEAR finishes
            // (updateSwapStatus sets it).
            received_amount: swap ? "0" : payout.merchantAmount.toString(),
            network_fee: payout.networkFee.toString(),
            platform_fee: payout.platformFee.toString(),
            ...(swap ? swapFieldsToSave(swap) : {}),
          },
        },
        { returnDocument: "after" },
      )
        .select("+tx.raw")
        .exec();

      if (invoice === null) {
        console.warn("Another run claimed it first", invoiceId);
        return;
      }
    }

    const txId = invoice.tx?.out;
    const hex = invoice.tx?.raw;

    if (!txId || !hex) {
      await Invoice.updateOne(
        { invoice_id: invoiceId, crypto: "ltc", status: "processing" },
        {
          $set: {
            review_reason: `Invoice is processing but has no saved LTC transaction. The claim always saves it, so this is a bug or a manual DB edit. Funds may still be at deposit address ${invoice.address}; check a block explorer before resending anything.`,
          },
        },
      ).exec();
      console.error(
        "LTC invoice is processing but has no saved tx; needs review:",
        invoiceId,
      );
      return;
    }

    const confirmations = await getLtcConfirmations(txId);
    const isSwap = invoice.to_crypto !== "ltc";

    if (confirmations === undefined) {
      // The network doesn't know this tx. Too close to NEAR's deadline, a
      // deposit would arrive late and be refunded, so don't send it.
      if (isSwap && !hasSwapTimeLeft(invoice.swap?.deadline)) {
        const result = await Invoice.updateOne(
          { invoice_id: invoiceId, crypto: "ltc", status: "processing", "tx.out": txId },
          {
            $set: {
              status: "failed",
              "timestamps.failed": Date.now(),
              review_reason: `Swap payout ${txId} was never seen by the network, and NEAR's deadline (${invoice.swap?.deadline || "missing"}) is too close, so it was not sent again. The LTC should still be at deposit address ${invoice.address}. Set the status back to "confirmed" to get a new quote, or pay out manually. A new payout spends the same coins, so the old tx and a new one can never both confirm.`,
            },
          },
        ).exec();
        if (result.modifiedCount > 0) {
          console.error("LTC swap payout stopped near the NEAR deadline:", invoiceId, txId);
        }
        return;
      }

      const sent = await broadcastLtcTx(hex);
      if (sent === txId) {
        console.log("LTC payout broadcast:", invoiceId, txId);
      } else if (sent !== undefined) {
        // The txid is a hash of the hex, so this can't happen unless something is broken.
        console.error("LTC broadcast returned another txid:", invoiceId, txId, sent);
      }
      // post() already logs why a broadcast failed.
    }

    if (confirmations === undefined || confirmations === 0) {
      const processingAt = invoice.timestamps?.processing;
      if (
        processingAt != null &&
        Date.now() - processingAt >= STUCK_TX_REVIEW_MS
      ) {
        const reason = `LTC payout ${txId} is not confirmed after 24 hours. Funds are still at deposit address ${invoice.address} until it confirms. It is rebroadcast every round; check the logs for the broadcast error. This signed tx can still confirm, so do not pay the merchant from another wallet: a replacement must spend the same deposit UTXOs, so only one can ever confirm.`;

        const result = await Invoice.updateOne(
          {
            invoice_id: invoiceId,
            crypto: "ltc",
            status: "processing",
            review_reason: { $ne: reason },
          },
          { $set: { review_reason: reason } },
        ).exec();

        if (result.modifiedCount === 1) {
          console.error("LTC payout stuck; needs review:", invoiceId, txId);
        }
      }
      return;
    }

    // Swap: the LTC reached NEAR. NEAR's status completes the invoice
    // (updateSwapStatus in swap/near.ts).
    if (isSwap) return;

    const result = await Invoice.updateOne(
      { invoice_id: invoiceId, crypto: "ltc", status: "processing", "tx.out": txId },
      {
        $set: {
          status: "completed",
          "timestamps.completed": Date.now(),
          review_reason: "",
        },
      },
    ).exec();

    if (result.modifiedCount > 0) {
      console.log("LTC payout completed:", invoiceId, txId);
    }
  } catch (error) {
    console.error(
      "LTC payout could not finish; invoice state was preserved:",
      invoiceId,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}
