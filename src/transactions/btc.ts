import bitcore from "bitcore-lib";
import { z } from "zod";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "../money/format.js";
import { splitPayout } from "../money/payout-split.js";
import { openSecret } from "../security/secret-envelope.js";
import type { PayoutRequest, PayoutResult, Transfer } from "../chains/adapter.js";
import type { BlockbookApi } from "../chains/blockbook.js";

const BTC_DECIMALS = 8;

async function getBtcUtxos(api: BlockbookApi, address: string) {
  if (!validateAdd(address)) {
    console.error("Invalid Address input", address);
    return undefined;
  }
  const res = await api.get(`/utxo/${encodeURIComponent(address)}?confirmed=true`);

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

async function getBtcNetworkFee(api: BlockbookApi) {
  const res = await api.get("/estimatefee/2");

  const parsed = z.object({ result: z.string() }).safeParse(await res);
  if (!parsed.success) {
    console.warn("Unexpected Blockbook fee-estimate response: ", parsed.error.message);
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
  feeRate: bigint,
  feeExempt: bigint,
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

  const split = splitPayout({ received: total, networkCost: networkFee, feeRate, feeExempt });
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
export async function estimateBtcPayoutNetworkCost(api: BlockbookApi): Promise<bigint | undefined> {
  const networkFeeRate = await getBtcNetworkFee(api);
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
  merchantFeeRate: bigint;
  feeExempt: bigint;
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
    feeExempt,
    utxos,
  } = input;
  const inputCount = utxos.length;
  const total = utxos.reduce((sum, u) => sum + u.amount, 0n);

  const payoutFor = (outputAddresses: string[], feeRate: bigint) => {
    const txSize = estimateBtcTxSize(inputCount, outputAddresses);
    if (txSize === undefined) return undefined;
    const payout = calculateBtcPayout(total, txSize, networkFeeRate, feeRate, feeExempt);
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
      ? payoutFor([merchantAddress], 0n)
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

async function getBtcConfirmations(api: BlockbookApi, txId: string): Promise<number | undefined> {
  const res = await api.get(`/tx/${txId}`);
  const parsed = z
    .object({
      txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
      confirmations: z.number().int().nonnegative(),
    })
    .safeParse(res);

  return parsed.success ? parsed.data.confirmations : undefined;
}

async function broadcast(api: BlockbookApi, hex: string) {
  const res = await api.post("/sendtx/", hex);
  const parsed = z
    .object({ result: z.string().regex(/^[0-9a-fA-F]{64}$/) })
    .safeParse(res);
  return parsed.success ? parsed.data.result.toLowerCase() : undefined;
}

function findPermanentPayoutProblem(input: {
  toCrypto: string;
  depositAddress: string;
  merchantAddress: string;
}): string | undefined {
  const {
    toCrypto,
    depositAddress,
    merchantAddress,
  } = input;

  if (toCrypto !== "btc") return `a BTC deposit pays out only as btc, not ${toCrypto}`;

  if (
    !validateAdd(depositAddress) ||
    new bitcore.Address(depositAddress, bitcore.Networks.livenet).type !==
      "pubkeyhash"
  )
    return "Expected a P2PKH mainnet deposit address";

  if (!validateAdd(merchantAddress))
    return `Merchant payout address is not a valid ${toCrypto} address`;

  if (merchantAddress === depositAddress)
    return "Payout address must differ from the deposit address";

  return undefined;
}

// What a confirmed payout transaction sent, read back from its own bytes:
// the first output is the destination, the second (if any) the platform fee
// (see prepareBtcPayout).
function sentByBtcTransaction(hex: string, destinationKind: Transfer["kind"]): Transfer[] {
  const tx = new bitcore.Transaction(hex);
  return tx.outputs.map((output, index) => ({
    kind: index === 0 ? destinationKind : "platform_fee",
    to: String(output.script.toAddress()),
    amount: BigInt(output.satoshis),
    txid: tx.id,
  }));
}

/**
 * The BTC side of ChainAdapter.payout (src/chains/adapter.ts): pays
 * request.destination from the deposit, or follows the transaction saved in
 * request.checkpoint (its raw hex). Never touches the database.
 */
export async function payOutBtc(
  request: PayoutRequest,
  deps: { platformAddress: string; api: BlockbookApi },
): Promise<PayoutResult> {
  const { platformAddress, api } = deps;
  if (!validateAdd(platformAddress)) {
    throw new Error("Platform BTC address is not a valid mainnet Bitcoin address");
  }
  const depositAddress = request.depositAddress;
  const toCrypto = request.receiveAsset;
  const destinationKind: Transfer["kind"] = request.destinationKind;
  const pending = (reason: string): PayoutResult => ({ status: "pending", reason });
  const fail = (reason: string): PayoutResult => ({
    status: "failed",
    message: `BTC payout stopped: ${reason}. Nothing was sent: all funds are still at deposit address ${depositAddress}. Fix the cause, then set the invoice back to "confirmed" to retry, or move the funds by hand with the deposit key.`,
    transfers: [],
  });

  let hex: string;

  if (request.checkpoint === undefined) {
    const problem = findPermanentPayoutProblem({
      toCrypto,
      depositAddress,
      merchantAddress: request.destination,
    });

    if (problem !== undefined) return fail(problem);

    const networkFeeRate = await getBtcNetworkFee(api);
    if (networkFeeRate === undefined) return pending("BTC fee rate unavailable");
    const utxos = await getBtcUtxos(api, depositAddress);
    if (utxos === undefined) return pending("BTC UTXOs unavailable");

    const utxosAmount = utxos.reduce((sum, u) => sum + u.amount, 0n);
    // The same minimum the watcher confirmed at, tolerance included.
    if (utxosAmount < request.minimumAmount) {
      return pending("spendable UTXOs are below the invoice amount");
    }

    const payout = prepareBtcPayout({
      platformAddress,
      merchantAddress: request.destination,
      networkFeeRate,
      merchantFeeRate: request.feeRate,
      feeExempt: request.feeExempt ?? 0n,
      utxos,
    });

    if (!payout) return { status: "too_small", reason: "BTC payout is too small after fees" };

    if (request.depositKey.kind !== "sealed_key") return fail("Deposit private key is missing");

    let signed;
    try {
      signed = signBtcTransaction({
        depositAddress,
        privateKey: openSecret("bitcoin-deposit-key", request.depositKey.sealed),
        utxos,
        outputs: payout.outputs,
        networkFee: payout.networkFee,
        networkFeeRate: networkFeeRate,
        estimateTxSize: payout.txSize,
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Signing failed");
    }

    const txid = signed.txid;
    const saved = await request.saveCheckpoint({
      state: signed.hex,
      plan: {
        transfers: payout.outputs.map((output, index) => ({
          kind: index === 0 ? destinationKind : "platform_fee",
          to: output.address,
          amount: output.amount,
          txid,
        })),
        platformFee: payout.platformFee,
        networkCost: payout.networkFee,
      },
    });
    if (!saved) return pending("another run saved this payout first");

    hex = signed.hex;
  } else {
    hex = request.checkpoint.state;
  }

  let txId: string;
  try {
    txId = new bitcore.Transaction(hex).id;
  } catch {
    return {
      status: "pending",
      reason: "unreadable saved BTC transaction",
      review: `Processing invoice had no readable saved BTC transaction. Funds may still be at deposit address ${depositAddress}; check an explorer before sending anything.`,
    };
  }

  const confirmations = await getBtcConfirmations(api, txId);

  if (confirmations === undefined) {
    const sent = await broadcast(api, hex);
    if (sent) console.log("BTC payout broadcast:", depositAddress, sent);
    // api.post() already logs the reason when it fails.
    return pending("broadcast; check its confirmations on the next round");
  }

  if (confirmations === 0) return pending("waiting for the first confirmation");
  return { status: "paid", transfers: sentByBtcTransaction(hex, destinationKind) };
}
