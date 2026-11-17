import bitcore from "bitcore-lib";
import { z } from "zod";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { env } from "../config/env.js";
import { ceilDivide } from "../money/format.js";
import { parseFeeRate, splitPayout } from "../money/payout-split.js";
import { acceptedPaymentAmount } from "../invoice/payment-rules.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { openSecret } from "../security/secret-envelope.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };
import {
  findSwapToken,
  getSwapQuote,
  getSwapStatus,
  getSwapTokens,
  SwapQuoteResponse,
} from "../swap/near.js";
import { isAddress } from "ethers";

const BTC_DECIMALS = 8;
const MIN_SWAP_TIME_LEFT_MS = 4 * 60 * 60 * 1000;

const BLOCKBOOK_URL = "https://btcbook.nownodes.io/api/v2";

async function get(path: string): Promise<unknown> {
  try {
    const res = await fetch(`${BLOCKBOOK_URL}${path}`, {
      headers: {
        "api-key": env.nowNodesApiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      // e.g. 400 {"error":"-26: txn-mempool-conflict"}. Worth seeing, and safe to log.
      console.warn("Blockbook GET failed:", path, res.status, await res.text());
      return undefined;
    }

    return await res.json();
  } catch (error) {
    console.warn(
      "Blockbook GET failed:",
      path,
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

async function post(path: string, body: string): Promise<unknown> {
  try {
    const res = await fetch(`${BLOCKBOOK_URL}${path}`, {
      method: "POST",
      headers: {
        "api-key": env.nowNodesApiKey,
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      signal: AbortSignal.timeout(10_000),
      body,
    });

    if (!res.ok) {
      // e.g. 400 {"error":"-26: txn-mempool-conflict"}. Worth seeing, and safe to log.
      console.warn(
        "Blockbook POST failed:",
        path,
        res.status,
        await res.text(),
      );
      return undefined;
    }

    return await res.json();
  } catch (error) {
    console.warn(
      "Blockbook POST failed:",
      path,
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

async function getBtcUtxos(address: string) {
  if (!validateAdd(address)) {
    console.error("Invalid Address input", address);
    return undefined;
  }
  const res = await get(`/utxo/${address}?confirmed=true`);

  const parsed = z
    .array(
      z.object({
        txid: z.string().regex(/^[0-9a-f]{64}$/), // 64 hex characters
        vout: z.number().int().nonnegative(),
        value: z.string().regex(/^[0-9]+$/), // digits only, so BigInt() can't throw
        confirmations: z.number(),
        coinbase: z.boolean().optional(), // Coinbase outputs can't be spent until they are 100 blocks deep.
      }),
    )
    .safeParse(res);
  if (!parsed.success) {
    console.warn("Unexpected Blockbook UTXO response: ", parsed.error.message);
    return undefined;
  }

  return parsed.data
    .filter((u) => u.confirmations >= (u.coinbase ? 100 : 1))
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      amount: BigInt(u.value),
    }));
}

async function getBtcNetworkFee() {
  const res = await get("/estimatefee/2");

  const parsed = z.object({ result: z.string() }).safeParse(await res);
  if (!parsed.success) {
    console.warn("Unexpected Blockbook UTXO response: ", parsed.error.message);
    return undefined;
  }

  const result = decimalStrToBigInt(parsed.data.result, BTC_DECIMALS);
  if (result === undefined || result <= 0n) return undefined;
  return result;
}

function calculateBtcPayout(
  total: bigint,
  txSize: number,
  networkFeeRate: bigint,
  merchantFeeRate: string,
):
  | {
      networkFee: bigint;
      platformFee: bigint;
      merchantAmount: bigint;
    }
  | undefined {
  if (!Number.isSafeInteger(txSize) || txSize < 1) {
    throw new RangeError("txSize must be a positive integer");
  }
  if (networkFeeRate <= 0n) {
    throw new RangeError("networkFeeRate must be positive");
  }
  if (total < 0n) {
    throw new RangeError("total must not be negative");
  }

  const networkFee = btcNetworkFee(txSize, networkFeeRate);
  const feeRate = parseFeeRate(merchantFeeRate);
  if (feeRate === undefined) return undefined;

  const split = splitPayout({ received: total, networkCost: networkFee, feeRate });
  if (split === undefined) return undefined;
  const { platformFee, merchantAmount } = split;

  return {
    networkFee,
    platformFee,
    merchantAmount,
  };
}

function estimateBtcTxSize(
  inputCount: number,
  outputAddresses: string[],
): number | undefined {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) {
    throw new RangeError("inputCount must be a positive integer");
  }
  if (outputAddresses.length === 0) {
    throw new RangeError("A transaction needs at least one output");
  }
  const scriptLengths: number[] = [];
  for (const output of outputAddresses) {
    const isAddValid = validateAdd(output);
    if (!isAddValid) return undefined;
    const addScript = bitcore.Script.fromAddress(output);

    scriptLengths.push(addScript.toBuffer().length);
  }
  return btcTxSize(inputCount, scriptLengths);
}

// P2PKH inputs (every deposit address is P2PKH); each output is its script
// plus 8 bytes of value and 1 of script length.
function btcTxSize(inputCount: number, outputScriptLengths: number[]): number {
  return (
    10 +
    148 * inputCount +
    outputScriptLengths.reduce((size, length) => size + length + 9, 0)
  );
}

function btcNetworkFee(txSize: number, networkFeeRate: bigint): bigint {
  return ceilDivide(BigInt(txSize) * networkFeeRate, 1000n);
}

// The widest standard output script (P2WSH, P2TR). A payout's outputs are not
// all known in advance: a swap pays NEAR's deposit address.
const WIDEST_OUTPUT_SCRIPT_LENGTH = 34;

/**
 * Payer-pays estimate, in satoshi: a payout of one payment (one input) to
 * two of the widest outputs, at today's fee rate. undefined if the fee rate
 * is unavailable.
 */
export async function estimateBtcPayoutNetworkCost(): Promise<bigint | undefined> {
  const networkFeeRate = await getBtcNetworkFee();
  if (networkFeeRate === undefined) return undefined;
  const txSize = btcTxSize(1, [WIDEST_OUTPUT_SCRIPT_LENGTH, WIDEST_OUTPUT_SCRIPT_LENGTH]);
  return btcNetworkFee(txSize, networkFeeRate);
}

function getBtcDustLimit(address: string): bigint | undefined {
  const isAddValid = validateAdd(address);
  if (!isAddValid) return undefined;
  const script = bitcore.Script.fromAddress(address);
  const scriptLength = script.toBuffer().length;
  const isWitness = script.isWitnessProgram();
  const witness = isWitness ? 67 : 148;
  const dust = (9 + scriptLength + witness) * 3;

  return BigInt(dust);
}

function validateAdd(address: string): boolean {
  return bitcore.Address.isValid(address, bitcore.Networks.livenet);
}

function prepareBtcPayout(input: {
  platformAddress: string;
  merchantAddress: string;
  networkFeeRate: bigint;
  merchantFeeRate: string;
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
  const {
    platformAddress,
    merchantAddress,
    networkFeeRate,
    merchantFeeRate,
    utxos,
  } = input;
  const inputCount = utxos.length;
  const total = utxos.reduce((sum, u) => sum + u.amount, 0n);

  const payoutFor = (outputAddresses: string[], feeRate: string) => {
    const txSize = estimateBtcTxSize(inputCount, outputAddresses);
    if (txSize === undefined) return undefined;
    const payout = calculateBtcPayout(total, txSize, networkFeeRate, feeRate);
    if (payout === undefined) return undefined;
    return { ...payout, txSize };
  };

  const withPlatform = payoutFor(
    [merchantAddress, platformAddress],
    merchantFeeRate,
  );
  if (!withPlatform) return undefined;

  const merchantDust = getBtcDustLimit(merchantAddress);
  if (merchantDust === undefined || merchantDust === 0n) return undefined;

  const platformDust = getBtcDustLimit(platformAddress);
  if (platformDust === undefined || platformDust === 0n) return undefined;

  const payout =
    withPlatform.platformFee < platformDust
      ? payoutFor([merchantAddress], "0")
      : withPlatform;
  if (payout === undefined) return undefined;

  if (payout.merchantAmount < merchantDust) return undefined;

  const outputs = [{ address: merchantAddress, amount: payout.merchantAmount }];
  if (payout.platformFee > 0n)
    outputs.push({ address: platformAddress, amount: payout.platformFee });

  return { ...payout, outputs };
}

function satoshisToNumber(satoshis: bigint): number {
  if (satoshis < 0n || satoshis > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Satoshi amount is outside the safe integer range");
  }

  return Number(satoshis);
}

function signBtcTransaction(input: {
  depositAddress: string;
  privateKey: string;
  utxos: { txid: string; vout: number; amount: bigint }[];
  outputs: { address: string; amount: bigint }[];
  networkFee: bigint;
  networkFeeRate: bigint;
  estimateTxSize: number;
}): { txid: string; hex: string } {
  const {
    depositAddress,
    utxos,
    outputs,
    networkFee,
    networkFeeRate,
    estimateTxSize,
  } = input;

  const inputAmount = utxos.reduce((sum, u) => sum + u.amount, 0n);
  const outputAmount = outputs.reduce((sum, o) => sum + o.amount, 0n);
  if (inputAmount - outputAmount !== networkFee) {
    throw new Error(
      `Inputs ${inputAmount} - outputs ${outputAmount} ≠ fee ${networkFee}`,
    );
  }
  const privateKey = new bitcore.PrivateKey(input.privateKey);
  if (privateKey.toAddress().toString() !== depositAddress)
    throw new Error("Deposit key does not match the deposit address");

  const sourceScript = bitcore.Script.fromAddress(depositAddress);

  const tx = new bitcore.Transaction().from(
    utxos.map(
      (u) =>
        new bitcore.Transaction.UnspentOutput({
          txId: u.txid,
          outputIndex: u.vout,
          script: sourceScript,
          satoshis: satoshisToNumber(u.amount),
        }),
    ),
  );

  if (tx.inputs.length !== utxos.length)
    throw new Error("Duplicate UTXOs: bitcore dropped some inputs");

  outputs.forEach((o) => {
    tx.to(o.address, satoshisToNumber(o.amount));
  });

  tx.feePerKb(satoshisToNumber(networkFeeRate));
  tx.fee(satoshisToNumber(networkFee));
  tx.sign(privateKey);
  const hex = tx.serialize({ disableDustOutputs: true });

  const actualTxSize = hex.length / 2;
  if (
    actualTxSize > estimateTxSize ||
    estimateTxSize - actualTxSize > utxos.length * 2
  )
    throw new Error(
      `Signed size ${actualTxSize} doesn't match the estimate ${estimateTxSize}`,
    );

  return {
    txid: tx.id,
    hex,
  };
}

const payoutAddressCheckers = new Map<string, (address: string) => boolean>([
  ["btc", validateAdd],
  ["usdceth", (address) => isAddress(address)],
]);

/** The coins a BTC deposit can be paid out as (directly, or by swap). */
export function canPayOutFromBtcDeposit(toCrypto: string): boolean {
  return payoutAddressCheckers.has(toCrypto);
}

function isCryptoId(value: string): value is keyof typeof cryptos {
  return Object.hasOwn(cryptos, value);
}

async function getBtcConfirmations(txId: string): Promise<number | undefined> {
  const res = await get(`/tx/${txId}`);
  const parsed = z
    .object({
      txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
      confirmations: z.number().int().nonnegative(),
    })
    .safeParse(res);

  return parsed.success ? parsed.data.confirmations : undefined;
}

async function broadcast(hex: string) {
  const res = await post("/sendtx/", hex);
  const parsed = z
    .object({ result: z.string().regex(/^[0-9a-fA-F]{64}$/) })
    .safeParse(res);
  return parsed.success ? parsed.data.result.toLowerCase() : undefined;
}

function findPermanentPayoutProblem(input: {
  toCrypto: string;
  depositAddress: string;
  merchantAddress: string;
  merchantFeeRate: string;
}): string | undefined {
  const {
    toCrypto,
    depositAddress,
    merchantAddress,
    merchantFeeRate,
  } = input;

  if (!Object.hasOwn(cryptos, toCrypto)) return "Swap payout are not supported";

  if (
    !validateAdd(depositAddress) ||
    new bitcore.Address(depositAddress, bitcore.Networks.livenet).type !==
      "pubkeyhash"
  )
    return "Expected a P2PKH mainnet deposit address";

  const isValidPayoutAddress = payoutAddressCheckers.get(toCrypto);

  if (isValidPayoutAddress === undefined) return "Unsupported payout asset";

  if (!isValidPayoutAddress(merchantAddress))
    return `Merchant payout address is not a valid ${toCrypto} address`;

  if (merchantAddress === depositAddress)
    return "Payout address must differ from the deposit address";

  if (parseFeeRate(merchantFeeRate) === undefined)
    return "Invalid merchant fee rate";

  return undefined;
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
      const user = await User.findOne({ user_id: invoice.user_id })
        .select("merchant_fee")
        .exec();
      if (!user) {
        return await fail("Merchant not found");
      }

      const problem = findPermanentPayoutProblem({
        toCrypto: invoice.to_crypto,
        depositAddress: invoice.address,
        merchantAddress: invoice.to_address,
        merchantFeeRate: user.merchant_fee,
      });

      if (problem !== undefined) return await fail(problem);

      const merchantAddress = invoice.to_address;
      const networkFeeRate = await getBtcNetworkFee();
      if (networkFeeRate === undefined) {
        console.warn("BTC fee rate unavailable; will retry:", invoiceId);
        return;
      }
      const merchantFeeRate = user.merchant_fee;
      const utxos = await getBtcUtxos(invoice.address);
      if (utxos === undefined) {
        console.warn("BTC UTXOs unavailable; will retry:", invoiceId);
        return;
      }

      const utxosAmount = utxos.reduce((sum, u) => sum + u.amount, 0n);
      // The same minimum the watcher confirmed at, tolerance included.
      if (utxosAmount < acceptedPaymentAmount(invoice)) {
        console.warn(
          "Spendable UTXOs are below the invoice amount:",
          invoiceId,
        );
        return undefined;
      }

      const toCrypto = invoice.to_crypto;
      if (!isCryptoId(toCrypto)) return await fail("Unknown payout asset");

      const needSwap = invoice.to_crypto !== "btc";
      let payout: NonNullable<ReturnType<typeof prepareBtcPayout>> | undefined;
      let quote: SwapQuoteResponse | undefined;
      if (needSwap) {
        const prepared = await prepareBtcSwap({
          platformAddress,
          networkFeeRate,
          merchantFeeRate,
          utxos,
          toCrypto,
          recipient: invoice.to_address,
          refundAddress: invoice.address,
        });

        if (!prepared) {
          console.warn("Couldn't prepare the swap; will retry:", invoiceId);
          return;
        }
        payout = prepared.payout;
        quote = prepared.quote;
      } else {
        payout = prepareBtcPayout({
          platformAddress,
          merchantAddress,
          networkFeeRate,
          merchantFeeRate,
          utxos,
        });
      }

      if (!payout) {
        console.warn("BTC payout is too small after fees:", invoiceId);
        return undefined;
      }

      if (!invoice.private?.private_key)
        return await fail("Deposit private key is missing");

      let signed;
      try {
        signed = signBtcTransaction({
          depositAddress: invoice.address,
          privateKey: openSecret(
            "bitcoin-deposit-key",
            invoice.private.private_key,
          ),
          utxos,
          outputs: payout.outputs,
          networkFee: payout.networkFee,
          networkFeeRate: networkFeeRate,
          estimateTxSize: payout.txSize,
        });
      } catch (error) {
        return await fail(
          error instanceof Error ? error.message : "Signing failed",
        );
      }

      invoice = await Invoice.findOneAndUpdate(
        { invoice_id: invoiceId, status: "confirmed" },
        {
          $set: {
            status: "processing",
            "timestamps.processing": Date.now(),
            "tx.out": signed.txid,
            "tx.raw": signed.hex,
            received_amount: needSwap ? "0" : payout.merchantAmount.toString(),
            network_fee: payout.networkFee.toString(),
            platform_fee: payout.platformFee.toString(),
            ...(quote !== undefined && {
              "swap.deposit_address": quote.quote.depositAddress,
              "swap.deadline": quote.quote.deadline,
              "swap.status": "PENDING_DEPOSIT",
              "swap.quote_response": quote,
            }),
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
      console.error(
        "Processing invoice had no saved BTC transaction: ",
        invoiceId,
      );
      return;
    }

    const confirmations = await getBtcConfirmations(txId);

    const needSwap = invoice.to_crypto !== "btc";

    if (confirmations === undefined) {
      if (needSwap) {
        const expiresAt = Date.parse(invoice.swap?.deadline ?? ""); // NaN if it isn't a valid date

        if (
          !Number.isFinite(expiresAt) ||
          expiresAt - Date.now() < MIN_SWAP_TIME_LEFT_MS
        ) {
          console.warn(
            "Swap tx not sent: the NEAR deadline is missing, invalid, or too close:",
            invoiceId,
            invoice.swap?.deadline,
          );

          await Invoice.updateOne(
            { invoice_id: invoiceId, status: "processing", "tx.out": txId },
            {
              $set: {
                status: "failed",
                review_reason: `Swap tx was never sent: the NEAR deadline (${invoice.swap?.deadline || "missing"}) is missing, invalid, or too close. The BTC is still at the invoice address; get a new quote or pay the merchant manually.`,
                "timestamps.failed": Date.now(),
              },
            },
          );
          return;
        }
      }

      const sent = await broadcast(hex);
      if (sent) console.log("BTC payout broadcast:", invoiceId, sent);
      // post() already logs the reason when it fails.
      return; // success or not, check its confirmations on the next round
    }

    // when swap completed will never set in here
    if (invoice.to_crypto !== "btc") return;

    if (confirmations === 0) return undefined;
    const result = await Invoice.updateOne(
      { invoice_id: invoiceId, status: "processing", "tx.out": txId },
      { $set: { status: "completed", "timestamps.completed": Date.now() } },
    ).exec();

    if (result.modifiedCount > 0)
      return console.log("BTc payout completed:", invoiceId, txId);
  } catch (error) {
    console.error(
      "BTC payout could not finish; invoice state was preserved: ",
      invoiceId,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

async function findSwapAssets(
  toCrypto: keyof typeof cryptos,
): Promise<{ originAsset: string; destinationAsset: string } | undefined> {
  if (toCrypto === "btc") return undefined;
  const tokens = await getSwapTokens();
  if (tokens === undefined) {
    console.warn("Unable to get swap tokens");
    return undefined;
  }

  const originAsset = findSwapToken("btc", tokens);
  if (originAsset === undefined) {
    console.warn("No NEAR swap token for BTC");
    return undefined;
  }

  const destinationAsset = findSwapToken(toCrypto, tokens);
  if (destinationAsset === undefined) {
    console.warn("No NEAR swap token for: ", toCrypto);
    return undefined;
  }

  return {
    originAsset: originAsset.assetId,
    destinationAsset: destinationAsset.assetId,
  };
}

async function prepareBtcSwap(input: {
  platformAddress: string;
  networkFeeRate: bigint;
  merchantFeeRate: string;
  utxos: { txid: string; vout: number; amount: bigint }[];
  toCrypto: keyof typeof cryptos;
  recipient: string;
  refundAddress: string;
}): Promise<
  | {
      payout: {
        networkFee: bigint;
        platformFee: bigint;
        merchantAmount: bigint;
        txSize: number;
        outputs: { address: string; amount: bigint }[];
      };
      quote: SwapQuoteResponse;
    }
  | undefined
> {
  const { platformAddress, toCrypto, recipient, refundAddress, ...rest } =
    input;

  const assets = await findSwapAssets(toCrypto);
  if (assets === undefined) return undefined;

  let payout = prepareBtcPayout({
    ...rest,
    platformAddress,
    merchantAddress: platformAddress,
  });
  if (payout === undefined) return undefined;

  for (let i = 0; i < 3; i++) {
    const quote = await getSwapQuote({
      originAsset: assets.originAsset,
      destinationAsset: assets.destinationAsset,
      amount: payout.merchantAmount,
      recipient,
      refundAddress,
      dry: false,
    });
    if (quote === undefined) return undefined;

    const { depositAddress, deadline, amountIn } = quote.quote;
    if (depositAddress === undefined || !validateAdd(depositAddress)) {
      console.warn("Quote deposit address is invalid");
      return undefined;
    }
    if (
      depositAddress === platformAddress ||
      depositAddress === refundAddress
    ) {
      console.warn(
        "Quote deposit address cannot equal to platformAddress or refundAddress",
      );
      return undefined;
    }
    if (deadline === undefined) {
      console.warn("Quote deadline is invalid");
      return undefined;
    }
    const expiresAt = Date.parse(deadline); // NaN if it isn't a valid date
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt - Date.now() < MIN_SWAP_TIME_LEFT_MS
    ) {
      console.warn(
        "Quote deadline is too close or invalid:",
        toCrypto,
        deadline,
      );
      return undefined;
    }
    if (BigInt(amountIn) !== payout.merchantAmount) {
      console.warn("Quote input amount is not equal to we input amount");
      return undefined;
    }

    const finalPayout = prepareBtcPayout({
      ...rest,
      platformAddress,
      merchantAddress: depositAddress,
    });

    if (finalPayout === undefined) return undefined;

    if (finalPayout.merchantAmount !== payout.merchantAmount) {
      console.warn(
        "Swap amount changes after sizing with the real deposit address; re-quoting: ",
        toCrypto,
      );
      payout = finalPayout;
      continue;
    }

    return { payout: finalPayout, quote };
  }

  console.warn("Could not match the BTC payout to a swap quote: ", toCrypto);
  return undefined;
}

export async function updateSwapStatus(
  invoiceId: string,
  txId: string,
  depositAddress: string,
) {
  const swapStatus = await getSwapStatus(depositAddress);
  if (swapStatus === undefined) return;

  let changes: Record<string, unknown> = {};

  switch (swapStatus.status) {
    case "PENDING_DEPOSIT":
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      changes = {
        "swap.status": swapStatus.status,
      };
      break;
    case "SUCCESS": {
      const invoice = await Invoice.findOne({
        invoice_id: invoiceId,
        status: "processing",
        "tx.out": txId,
        "swap.deposit_address": depositAddress,
      })
        .select("+swap.quote_response")
        .exec();

      if (!invoice) return undefined;

      const savedQuote = z
        .object({
          quote: z.object({ minAmountOut: z.string().regex(/^[0-9]+$/) }),
        })
        .safeParse(invoice.swap?.quote_response);
      if (!savedQuote.success) {
        changes = {
          "swap.status": swapStatus.status,
          review_reason:
            "NEAR reported SUCCESS, but the saved quote is unreadable; check minAmountOut manually",
        };
        break;
      }
      const minAmountOut = BigInt(savedQuote.data.quote.minAmountOut);

      const { amountOut, destinationChainTxHashes } = swapStatus.swapDetails;

      if (amountOut == undefined) {
        changes = {
          "swap.status": swapStatus.status,
          review_reason: "NEAR reported SUCCESS without amountOut",
        };
        break;
      }

      if (destinationChainTxHashes.length < 1) {
        changes = {
          "swap.status": swapStatus.status,
          review_reason: "destinationChainTxHashes cannot be empty",
        };
        break;
      }
      if (BigInt(amountOut) < minAmountOut) {
        changes = {
          "swap.status": swapStatus.status,
          review_reason: "amountOut cannot be lower than minAmountOut",
        };
        break;
      }

      changes = {
        "swap.status": swapStatus.status,
        status: "completed",
        received_amount: amountOut,
        "swap.destination_txids": destinationChainTxHashes.map((tx) => tx.hash),
        "timestamps.completed": Date.now(),
      };
      break;
    }
    case "REFUNDED":
      changes = {
        "swap.status": swapStatus.status,
        status: "failed",
        "swap.refunded_amount": swapStatus.swapDetails.refundedAmount,
        review_reason: `Swap refunded;BTC refunded to the invoice address; pay the merchant manually. NEAR says: ${swapStatus.swapDetails.refundReason ?? "no reason given"}`,
        "timestamps.failed": Date.now(),
      };
      break;
    case "FAILED":
      changes = {
        "swap.status": swapStatus.status,
        status: "failed",
        review_reason: `Swap failed; check NEAR and the funds. NEAR says: ${swapStatus.swapDetails.refundReason ?? "no reason given"}`,
        "timestamps.failed": Date.now(),
      };
      break;
    case "INCOMPLETE_DEPOSIT":
      changes = {
        "swap.status": swapStatus.status,
        review_reason: "NEAR received less than quoted; investigate",
      };
      break;

    default:
      return;
  }

  await Invoice.updateOne(
    {
      invoice_id: invoiceId,
      status: "processing",
      "tx.out": txId,
      "swap.deposit_address": depositAddress,
    },
    { $set: changes },
  ).exec();
}
