import { z } from "zod";
import { env } from "../config/env.js";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import bitcore from "bitcore-lib";
import { ceilDivide } from "../money/format.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { openSecret } from "../security/secret-envelope.js";
import { getPrice } from "../invoice/price.function.js";

const PRICE_SCALE = 18;

const btcUtxosSchema = z.array(
  z.object({
    txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
    vout: z.number().int().nonnegative(),
    value: z.string().regex(/^[0-9]+$/),
    confirmations: z.number().int().positive(),
    // miner reward = coinbase (required 100 confirm to spend)
    coinbase: z.boolean().default(false),
  }),
);

async function requestBlockbook(
  path: string,
  init: RequestInit,
): Promise<unknown> {
  try {
    const res = await fetch("https://btcbook.nownodes.io/api/v2/" + path, {
      ...init,
      headers: {
        "api-key": env.nowNodesApiKey,
        Accept: "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

async function get(path: string): Promise<unknown> {
  return requestBlockbook(path, { method: "GET" });
}

async function post(path: string, body: string): Promise<unknown> {
  return requestBlockbook(path, {
    method: "POST",
    body,
    headers: { "Content-Type": "text/plain" },
  });
}

async function getBtcUtxos(address: string): Promise<
  | {
      txid: string;
      vout: number;
      amount: bigint;
      confirmations: number;
      coinbase: boolean;
    }[]
  | undefined
> {
  const data = await get(`utxo/${encodeURIComponent(address)}?confirmed=true`);
  const parsed = btcUtxosSchema.safeParse(data);

  if (!parsed.success) return undefined;

  return parsed.data
    .filter((utxo) => utxo.confirmations >= (utxo.coinbase ? 100 : 1))
    .map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      amount: BigInt(utxo.value),
      confirmations: utxo.confirmations,
      coinbase: utxo.coinbase,
    }))
    .filter((utxo) => utxo.amount > 0n);
}

async function getBtcFeeRate(): Promise<bigint | undefined> {
  const parsed = z
    .object({ result: z.string() })
    .safeParse(await get(`estimatefee/2?conservative=true`));
  if (!parsed.success) return undefined;

  const feeRate = decimalStrToBigInt(parsed.data.result, 8);

  return feeRate !== undefined && feeRate > 0n ? feeRate : undefined;
}

function estimateBtcTransactionSize(
  inputCount: number,
  outputAddresses: string[],
): number {
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > 252) {
    throw new RangeError("inputCount must be an integer from 1 to 252");
  }

  if (outputAddresses.length < 1 || outputAddresses.length > 252) {
    throw new RangeError("outputAddresses must be contain 1 to 252 addresses");
  }

  // Compressed-key P2PKH inputs only.
  const baseVbytes = 10; //version+vin.len+vout.len+locktime
  const vbytePerInput = 148; //single input size

  let transactionVbyte = baseVbytes + inputCount * vbytePerInput;

  for (const address of outputAddresses) {
    const script = bitcore.Script.fromAddress(address).toBuffer();

    const outputVbytes = 8 + 1 + script.length;

    transactionVbyte += outputVbytes;
  }

  return transactionVbyte;
}

function calculateMerchantPayout(input: {
  totalAmount: bigint;
  networkFee: bigint;
  merchantFeeRate: string; //0.005
}):
  | { networkFee: bigint; platformFee: bigint; merchantAmount: bigint }
  | undefined {
  const { totalAmount, networkFee, merchantFeeRate } = input;

  const feeRate = decimalStrToBigInt(merchantFeeRate, 8);

  const feeRateScale = 100_000_000n;

  if (
    feeRate === undefined ||
    feeRate > feeRateScale ||
    networkFee < 0n ||
    totalAmount <= networkFee
  )
    return undefined;

  const amountAfterNetworkFee = totalAmount - networkFee;

  const platformFee = ceilDivide(amountAfterNetworkFee * feeRate, feeRateScale);

  const merchantAmount = amountAfterNetworkFee - platformFee;

  if (merchantAmount <= 0n) return undefined;

  return {
    networkFee,
    platformFee,
    merchantAmount,
  };
}

function getBtcDustLimit(address: string): bigint {
  const script = bitcore.Script.fromAddress(address);
  const outputBytes = 8 + 1 + script.toBuffer().length;
  const spendingBytes = script.isWitnessProgram() ? 67 : 148;
  const dustSatsPerByte = 3n;

  return BigInt(outputBytes + spendingBytes) * dustSatsPerByte;
}

function prepareBtcPayout(input: {
  totalAmount: bigint;
  inputCount: number;
  merchantAddress: string;
  platformAddress: string;
  merchantFeeRate: string;
  satsPer1000Vbytes: bigint;
}):
  | {
      networkFee: bigint;
      platformFee: bigint;
      merchantAmount: bigint;
      transactionVbytes: number;
      output: { address: string; amount: bigint }[];
    }
  | undefined {
  const {
    totalAmount,
    inputCount,
    merchantAddress,
    platformAddress,
    merchantFeeRate,
    satsPer1000Vbytes,
  } = input;

  if (satsPer1000Vbytes <= 0n)
    throw new RangeError("Fee rate must be positive");

  let transactionVbytes = estimateBtcTransactionSize(inputCount, [
    merchantAddress,
    platformAddress,
  ]);

  let networkFee = ceilDivide(
    satsPer1000Vbytes * BigInt(transactionVbytes),
    1000n,
  );

  let payout = calculateMerchantPayout({
    totalAmount,
    networkFee,
    merchantFeeRate,
  });

  if (!payout) return undefined;

  if (payout.platformFee < getBtcDustLimit(platformAddress)) {
    transactionVbytes = estimateBtcTransactionSize(inputCount, [
      merchantAddress,
    ]);

    networkFee = ceilDivide(
      satsPer1000Vbytes * BigInt(transactionVbytes),
      1000n,
    );

    payout = {
      networkFee,
      platformFee: 0n,
      merchantAmount: totalAmount - networkFee,
    };
  }

  if (payout.merchantAmount < getBtcDustLimit(merchantAddress))
    return undefined;

  const output = [{ address: merchantAddress, amount: payout.merchantAmount }];

  if (payout.platformFee > 0n) {
    output.push({ address: platformAddress, amount: payout.platformFee });
  }

  return { ...payout, transactionVbytes, output };
}

function satoshisToNumber(amount: bigint): number {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Satoshi amount is outside the safe number range");
  }

  return Number(amount);
}

async function satoshisToFiatUnits(
  satoshis: bigint,
): Promise<string | undefined> {
  try {
    const price = await getPrice("btc", "usd");
    if (price === undefined) return undefined;

    const priceUnits = decimalStrToBigInt(price, PRICE_SCALE);
    if (priceUnits === undefined) return undefined;

    // sats ÷ 10^8 = BTC;  × price = USD;  × 100 = cents
    const cents =
      (satoshis * priceUnits * 100n) /
      (100_000_000n * 10n ** BigInt(PRICE_SCALE));

    return cents.toString();
  } catch {
    return undefined;
  }
}

async function broadcastBtcTransaction(
  transactionHex: string,
): Promise<string | undefined> {
  const parsed = z
    .object({ result: z.string().regex(/^[0-9a-fA-F]{64}$/) })
    .safeParse(await post("sendtx/", transactionHex));
  return parsed.success ? parsed.data.result.toLowerCase() : undefined;
}

export async function transferBtcToMerchant(
  invoiceId: string,
  platformAddress: string,
) {
  try {
    let invoice = await Invoice.findOne({
      invoice_id: invoiceId,
      crypto: "btc",
      status: { $in: ["confirmed", "processing"] },
    })
      .select("+private.private_key +tx.raw")
      .exec();

    if (!invoice) return undefined;

    async function fail(reason: string) {
      await Invoice.updateOne(
        { invoice_id: invoiceId, status: "confirmed" },
        { $set: { status: "failed", "timestamps.failed": Date.now() } },
      ).exec();

      console.error("BTC payout failed:", invoiceId, reason);
    }

    if (invoice.status === "confirmed") {
      if (invoice.to_crypto !== "btc" || invoice.fee_paid_by_payer)
        return await fail(
          "Only BTC payout with merchant-paid fees are supported",
        );

      const user = await User.findOne({ user_id: invoice.user_id })
        .select("merchant_fee")
        .exec();

      if (!user) return await fail("Merchant was not found");

      if (!invoice.private?.private_key)
        return await fail("Deposit private key is missing");

      const merchantAddress = invoice.to_address;

      const sourceScript = bitcore.Script.fromAddress(invoice.address);

      for (const address of [
        invoice.address,
        merchantAddress,
        platformAddress,
      ]) {
        // make sure all address exit in mainnet
        if (new bitcore.Address(address).network !== bitcore.Networks.livenet)
          return await fail("Expected Bitcoin mainnet addresses");
      }
      // make sure invoice.address is P2PKH
      if (!sourceScript.isPublicKeyHashOut())
        return await fail("Expected a P2PKH deposit address");

      if (
        merchantAddress === invoice.address ||
        platformAddress === invoice.address
      )
        return await fail(
          "Payout address must differ from the deposit address",
        );

      const feeRate = decimalStrToBigInt(user.merchant_fee, 8);

      if (feeRate === undefined || feeRate >= 100_000_000n)
        return await fail("Invalid merchant fee rate");

      // ─── Fetch confirmed UTXOs ──────────────────────────────────────────
      const utxos = await getBtcUtxos(invoice.address);
      const satsPer1000Vbytes = await getBtcFeeRate();

      if (!utxos?.length || satsPer1000Vbytes === undefined) {
        console.warn(
          "BTC payout is waiting for UTXOs or a fee estimate: ",
          invoiceId,
        );
        return;
      }
      // count total amount from utxo
      const totalAmount = utxos.reduce(
        (total, utxo) => total + utxo.amount,
        0n,
      );

      if (totalAmount < BigInt(invoice.amount)) return;

      satoshisToNumber(totalAmount);

      // ─── Calculate outputs ──────────────────────────────────────────────
      const payout = prepareBtcPayout({
        totalAmount,
        inputCount: utxos.length,
        merchantAddress,
        platformAddress,
        merchantFeeRate: user.merchant_fee,
        satsPer1000Vbytes,
      });

      if (!payout) {
        console.warn("BTC payout is too small after fees:", invoiceId);
        return;
      }

      const privateKey = new bitcore.PrivateKey(
        openSecret("bitcoin-deposit-key", invoice.private.private_key),
      );

      if (
        privateKey.toAddress().toString() !== invoice.address ||
        privateKey.publicKey.toBuffer().length !== 33
      )
        return await fail(
          "Deposit address and compressed private key do not match",
        );

      // create transaction & input transaction vin
      const transaction = new bitcore.Transaction().from(
        utxos.map(
          (utxo) =>
            new bitcore.Transaction.UnspentOutput({
              txId: utxo.txid,
              outputIndex: utxo.vout,
              script: sourceScript,
              satoshis: satoshisToNumber(utxo.amount),
            }),
        ),
      );

      // bitcore never throw err when a duplicate transaction in a utxos
      if (transaction.inputs.length !== utxos.length) {
        throw new Error("Duplicate UTXOs");
      }
      // input transaction vout
      for (const output of payout.output) {
        transaction.to(output.address, satoshisToNumber(output.amount));
      }

      // ─── Build & sign transaction ───────────────────────────────────────
      transaction.feePerKb(satoshisToNumber(satsPer1000Vbytes));

      transaction.fee(satoshisToNumber(payout.networkFee)).sign(privateKey);

      // disable 546 dust checking, dust may lower than 546
      const transactionHex = transaction.serialize({
        disableDustOutputs: true,
      });

      const actualFeeRequired = ceilDivide(
        satsPer1000Vbytes * BigInt(transactionHex.length / 2),
        1000n,
      );

      if (payout.networkFee < actualFeeRequired)
        throw new Error("Signed transaction exceeds the fee estimate");

      // A signed P2PKH input is 147 or 148 bytes: the DER signature gains a byte
      // when r's high bit is set. The estimate assumes 148, so the real size can
      // fall short by about a byte per input. Allow 2 per input to cover the rare
      // case, plus 1 sat for the two separate round-ups.
      const sizeSlackBytes = BigInt(utxos.length) * 2n;
      const tolerance =
        ceilDivide(satsPer1000Vbytes * sizeSlackBytes, 1000n) + 1n;

      if (payout.networkFee > actualFeeRequired + tolerance) {
        throw new Error(
          "Signed transaction pays more fee than its size requires",
        );
      }
      const receivedAmountFiat = await satoshisToFiatUnits(
        payout.merchantAmount,
      );
      

      // ─── Save transaction to db ───────────────────────────────────────
      invoice = await Invoice.findOneAndUpdate(
        { invoice_id: invoiceId, status: "confirmed" },
        {
          $set: {
            status: "processing",
            "timestamps.processing": Date.now(),
            "tx.out": transaction.id,
            "tx.raw": transactionHex,
            received_amount: payout.merchantAmount.toString(),
            ...(receivedAmountFiat !== undefined && {
              received_amount_fiat: receivedAmountFiat,
            }),
            network_fee: payout.networkFee.toString(),
            platform_fee: payout.platformFee.toString(),
          },
        },
        { returnDocument: "after" },
      )
        .select("+tx.raw")
        .exec();

      if (!invoice) return undefined;
    }

    // ─── Broadcast ──────────────────────────────────────────────────────
    const transactionId = invoice.tx?.out;
    const transactionHex = invoice.tx?.raw;

    if (!transactionId || !transactionHex) {
      console.error(
        "Processing invoice had no saved BTC transaction: ",
        invoiceId,
      );
      return;
    }

    const existing = z
      .object({ txid: z.string().regex(/^[0-9a-fA-F]{64}$/) })
      .safeParse(await get(`tx/${transactionId}`));

    const alreadyBroadcast =
      existing.success && existing.data.txid.toLowerCase() === transactionId;

    if (!alreadyBroadcast) {
      const broadcastId = await broadcastBtcTransaction(transactionHex);

      if (broadcastId !== transactionId) {
        console.warn(
          "BTC broadcast outcome is unknown; keep processing:",
          invoiceId,
          transactionId,
        );
        return;
      }
    }

    const update = await Invoice.updateOne(
      {
        invoice_id: invoiceId,
        status: "processing",
        "tx.out": transactionId,
      },
      { $set: { status: "completed", "timestamps.completed": Date.now() } },
    ).exec();

    if (update.modifiedCount > 0)
      console.log("BTC payout broadcast", invoiceId, transactionId);
  } catch {
    console.error(
      "BTC payout could not finish; invoice state was preserved: ",
      invoiceId,
    );
  }
}
// ─── Swap helpers ──────────────────────────────────────────────────────────────

