import litecore from "bitcore-lib-ltc";
import { z } from "zod";
import type { PayoutRequest, PayoutResult, Transfer } from "../chains/adapter.js";
import type { BlockbookApi } from "../chains/blockbook.js";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "../money/format.js";
import { splitPayout } from "../money/payout-split.js";
import { openSecret } from "../security/secret-envelope.js";

// Litecoin: LTC -> LTC payout from a P2PKH deposit.
// Chain data comes from a Blockbook API (NOWNodes in production), the same
// API as btc.ts; payments are listed by getBlockbookPayments.

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

const txIdSchema = z.string().regex(/^[0-9a-fA-F]{64}$/);
const litoshiString = z.string().regex(/^[0-9]+$/); // digits only, so BigInt() can't throw

// ---------- Blockbook API ----------

// Spendable outputs at `address`, in litoshi. Unconfirmed and immature
// coinbase outputs are left out, because spending them can fail.
async function getLtcUtxos(api: BlockbookApi, address: string) {
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
    .safeParse(await api.get(`/utxo/${encodeURIComponent(address)}?confirmed=true`));

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
async function getLtcFeePerKb(api: BlockbookApi) {
  const parsed = z
    .object({ result: z.string() })
    .safeParse(await api.get("/estimatefee/2"));

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
async function getLtcConfirmations(api: BlockbookApi, txId: string) {
  if (!txIdSchema.safeParse(txId).success) return undefined;

  const parsed = z
    .object({
      txid: txIdSchema,
      confirmations: z.number().int().nonnegative(),
    })
    .safeParse(await api.get(`/tx/${txId}`));

  if (!parsed.success) return undefined;
  if (parsed.data.txid.toLowerCase() !== txId.toLowerCase()) return undefined;

  return parsed.data.confirmations;
}

// Sends a signed transaction (hex). Returns its txid in lowercase.
async function broadcastLtcTx(api: BlockbookApi, hex: string) {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return undefined;

  const parsed = z
    .object({ result: txIdSchema })
    .safeParse(await api.post("/sendtx/", hex));

  return parsed.success ? parsed.data.result.toLowerCase() : undefined;
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
  feeExempt: bigint,
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
  const split = splitPayout({ received: total, networkCost: networkFee, feeRate, feeExempt });
  if (split === undefined) return undefined;

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
  const { platformAddress, merchantAddress, feePerKb, feeRate, feeExempt, utxos } = input;
  if (utxos.length === 0) return undefined;

  const total = utxos.reduce((sum, u) => sum + u.amount, 0n);

  const payoutFor = (outputAddresses: string[], rate: bigint) => {
    const txSize = estimateLtcTxSize(utxos.length, outputAddresses);
    if (txSize === undefined) return undefined;
    const payout = calculateLtcPayout(total, txSize, feePerKb, rate, feeExempt);
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

// The widest standard output script (P2WSH; Litecoin has no P2TR outputs in
// use). The estimate is made before the destination is known.
const WIDEST_OUTPUT_SCRIPT_LENGTH = 34;

/**
 * Payer-pays estimate, in litoshi: a payout of one payment (one input) to
 * two of the widest outputs, at today's fee rate. undefined if the fee rate
 * is unavailable.
 */
export async function estimateLtcPayoutNetworkCost(api: BlockbookApi): Promise<bigint | undefined> {
  const feePerKb = await getLtcFeePerKb(api);
  if (feePerKb === undefined) return undefined;
  const outputSize = 8 + varIntSize(WIDEST_OUTPUT_SCRIPT_LENGTH) + WIDEST_OUTPUT_SCRIPT_LENGTH;
  const txSize = 8 + varIntSize(1) + varIntSize(2) + P2PKH_INPUT_SIZE + 2 * outputSize;
  return ceilDivide(BigInt(txSize) * feePerKb, 1000n);
}

// What a confirmed payout transaction sent, read back from its own bytes:
// the first output is the destination, the second (if any) the platform fee
// (see prepareLtcPayout).
function sentByLtcTransaction(hex: string, destinationKind: Transfer["kind"]): Transfer[] {
  const tx = new litecore.Transaction(hex);
  const txid = tx.id.toLowerCase();
  return tx.outputs.map((output, index) => ({
    kind: index === 0 ? destinationKind : "platform_fee",
    // bitcore takes a network here; its types don't say so.
    to: String((output.script as unknown as { toAddress(network: unknown): unknown }).toAddress(LTC_NETWORK)),
    amount: BigInt(output.satoshis),
    txid,
  }));
}

// ---------- Payout flow ----------

/**
 * The LTC side of ChainAdapter.payout (src/chains/adapter.ts): pays
 * request.destination from the deposit, or follows the transaction saved in
 * request.checkpoint (its raw hex). Never touches the database.
 */
export async function payOutLtc(
  request: PayoutRequest,
  deps: { platformAddress: string; api: BlockbookApi },
): Promise<PayoutResult> {
  const { platformAddress, api } = deps;
  // Our own config, not the invoice: never fail an invoice for it.
  if (!isValidLtcAddress(platformAddress)) {
    throw new Error("Platform LTC address is not a valid Litecoin address");
  }

  const { depositAddress, destination, destinationKind } = request;
  const pending = (reason: string): PayoutResult => ({ status: "pending", reason });
  const fail = (reason: string): PayoutResult => ({
    status: "failed",
    message: `LTC payout stopped: ${reason}. Nothing was sent: all funds are still at deposit address ${depositAddress}. Fix the cause, then set the invoice back to "confirmed" to retry, or move the funds by hand with the deposit key.`,
    transfers: [],
  });

  let hex: string;

  if (request.checkpoint === undefined) {
    if (request.receiveAsset !== "ltc") {
      return fail(`an LTC deposit can't be paid out as ${request.receiveAsset}`);
    }
    if (
      !isValidLtcAddress(depositAddress) ||
      new litecore.Address(depositAddress, LTC_NETWORK).type !== "pubkeyhash"
    ) {
      return fail("the deposit is not a mainnet P2PKH (L...) address, and the fee math only fits that type");
    }
    if (!isValidLtcAddress(destination)) {
      return fail(`destination "${destination}" is not a valid Litecoin address (MWEB "ltcmweb1" addresses are not supported)`);
    }
    if (destination === depositAddress) {
      return fail("the destination is the deposit address itself");
    }
    if (request.depositKey.kind !== "sealed_key") return fail("the deposit private key is missing");

    const feePerKb = await getLtcFeePerKb(api);
    if (feePerKb === undefined) return pending("LTC fee rate unavailable");

    const utxos = await getLtcUtxos(api, depositAddress);
    if (utxos === undefined) return pending("LTC UTXOs unavailable");

    const total = utxos.reduce((sum, u) => sum + u.amount, 0n);
    // Blockbook can lag behind the payment check; try again next round.
    if (total < request.minimumAmount) return pending("spendable LTC is below the payout minimum");

    const payout = prepareLtcPayout({
      platformAddress,
      merchantAddress: destination,
      feePerKb,
      feeRate: request.feeRate,
      feeExempt: request.feeExempt ?? 0n,
      utxos,
    });
    if (payout === undefined) return { status: "too_small", reason: "LTC payout is too small after fees" };

    let signed: { txid: string; hex: string };
    try {
      signed = signLtcTransaction({
        depositAddress,
        wif: openSecret("litecoin-deposit-key", request.depositKey.sealed),
        utxos,
        outputs: payout.outputs,
        networkFee: payout.networkFee,
        feePerKb,
        estimatedSize: payout.txSize,
      });
    } catch (error) {
      return fail(`signing failed (${error instanceof Error ? error.message : "unknown error"})`);
    }

    // Save the signed tx before broadcasting it, so a crash can't lose it.
    const saved = await request.saveCheckpoint({
      state: signed.hex,
      plan: {
        transfers: payout.outputs.map((output, index) => ({
          kind: index === 0 ? destinationKind : "platform_fee",
          to: output.address,
          amount: output.amount,
          txid: signed.txid,
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
    txId = new litecore.Transaction(hex).id.toLowerCase();
  } catch {
    return {
      status: "pending",
      reason: "unreadable saved LTC transaction",
      review: `The saved LTC payout transaction is unreadable. Funds may still be at deposit address ${depositAddress}; check a block explorer before sending anything.`,
    };
  }

  const confirmations = await getLtcConfirmations(api, txId);

  // Unknown to the network (or the lookup failed): send the same signed tx
  // again. It has the same txid and can only be mined once.
  if (confirmations === undefined) {
    const sent = await broadcastLtcTx(api, hex);
    if (sent === txId) {
      console.log("LTC payout broadcast:", depositAddress, txId);
    } else if (sent !== undefined) {
      // The txid is a hash of the hex, so this can't happen unless something is broken.
      console.error("LTC broadcast returned another txid:", depositAddress, txId, sent);
    }
    // api.post() already logs why a broadcast failed.
    return pending("broadcast; check its confirmations on the next round");
  }

  if (confirmations === 0) return pending("waiting for the first confirmation");
  return { status: "paid", transfers: sentByLtcTransaction(hex, destinationKind) };
}
