import { z } from "zod";
import { env } from "../config/env.js";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "../money/format.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { getAddress, isAddress, keccak256, Wallet } from "ethers";
import { openSecret } from "../security/secret-envelope.js";

const ETH_CHAIN_ID = 1n;
const ETH_TRANSFER_GAS = 21_000n;

const MERCHANT_NONCE = 0;
const PLATFORM_NONCE = 1;

// merchant_fee is a rate such as "0.005". Scale it up to a whole number so bigint can use it.
const FEE_RATE_DECIMALS = 8;
const FEE_RATE_SCALE = 10n ** BigInt(FEE_RATE_DECIMALS);

// Increase the suggested legacy gas price by 25%.
// This increases the actual fee and does not guarantee inclusion.
const GAS_PRICE_HEADROOM_PERCENT = 125n;

// JSON-RPC sends numbers as hex strings without leading zeros, e.g. "0x5208" = 21000.
const quantitySchema = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);

// A transaction hash: "0x" followed by 64 hex characters.
const transactionIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

// The receipt fields we use. A receipt only exists once the transaction is in a block.
const receiptSchema = z.object({
  transactionHash: transactionIdSchema,
  blockNumber: quantitySchema,
  status: z.enum(["0x0", "0x1"]), // "0x1" = success, "0x0" = reverted
  gasUsed: quantitySchema, // gas actually used; 21000 for a plain transfer
  effectiveGasPrice: quantitySchema, // price actually paid per gas, in wei
});

const rpcErrorSchema = z.object({
  error: z.object({ code: z.number(), message: z.string() }),
});

const rpcResultSchema = z.object({ result: z.unknown() });

/**
 * Calls one Ethereum JSON-RPC method on NOWNodes and returns its `result`.
 * Returns undefined when the request fails or the node answers with an error.
 */
async function post(method: string, params: unknown[]): Promise<unknown> {
  try {
    const res = await fetch("https://eth.nownodes.io/", {
      method: "POST",
      headers: {
        "api-key": env.nowNodesApiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });

    if (!res.ok) {
      console.warn("ETH RPC HTTP error:", method, res.status);
      return undefined;
    }

    const body: unknown = await res.json();

    // Check for an error first, so the node's reason is logged instead of lost.
    // Never log params: for eth_sendRawTransaction they hold the whole signed transaction.
    const rpcError = rpcErrorSchema.safeParse(body);
    if (rpcError.success) {
      console.warn(
        "ETH RPC error:",
        method,
        rpcError.data.error.code,
        rpcError.data.error.message,
      );
      return undefined;
    }

    // `result: null` is a real answer, e.g. a receipt for a transaction not yet in a block.
    const parsed = rpcResultSchema.safeParse(body);

    return parsed.success ? parsed.data.result : undefined;
  } catch (error) {
    // Timeouts and network failures land here.
    console.warn(
      "ETH RPC request failed:",
      method,
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

/** Calls a method that returns a hex number, and converts the result to bigint. */
async function getEthQuantity(method: string, params: unknown[]) {
  const parsed = quantitySchema.safeParse(await post(method, params));

  return parsed.success ? BigInt(parsed.data) : undefined;
}

/** Balance of an address in wei, as of the latest block. */
async function getEthBalance(address: string) {
  return getEthQuantity("eth_getBalance", [address, "latest"]);
}

/** The node's current gas price in wei. Returns undefined if it is missing or zero. */
async function getEthGasPrice() {
  const gasPrice = await getEthQuantity("eth_gasPrice", []);

  return gasPrice !== undefined && gasPrice > 0n ? gasPrice : undefined;
}

/**
 * How many transactions an address has sent, which is also its next nonce.
 * "latest" counts only transactions already in a block.
 * "pending" also counts ones still waiting in the node's mempool.
 */
async function getEthNonce(address: string, block: "latest" | "pending") {
  return getEthQuantity("eth_getTransactionCount", [address, block]);
}

/**
 * The contract code stored at an address.
 * "0x" (empty) means a normal wallet. Anything else is a contract or a delegated wallet.
 */
async function getEthCode(address: string) {
  const parsed = z
    .string()
    .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
    .safeParse(await post("eth_getCode", [address, "latest"]));

  return parsed.success ? parsed.data : undefined;
}

/**
 * Splits a deposit into the network fee, the platform fee and the merchant's share.
 * The platform fee is taken from what is left after the network fee, rounded up.
 * Returns undefined when the rate is invalid or nothing would be left for the merchant.
 */
function calculateMerchantPayout(input: {
  totalAmount: bigint;
  networkFee: bigint;
  merchantFeeRate: string;
}):
  | {
      networkFee: bigint;
      platformFee: bigint;
      merchantAmount: bigint;
    }
  | undefined {
  const { totalAmount, networkFee, merchantFeeRate } = input;

  const feeRate = decimalStrToBigInt(merchantFeeRate, FEE_RATE_DECIMALS);

  if (
    feeRate === undefined ||
    feeRate >= FEE_RATE_SCALE ||
    networkFee < 0n ||
    totalAmount <= networkFee
  )
    return undefined;

  const amountAfterNetworkFee = totalAmount - networkFee;

  const platformFee = ceilDivide(
    amountAfterNetworkFee * feeRate,
    FEE_RATE_SCALE,
  );

  const merchantAmount = amountAfterNetworkFee - platformFee;

  if (merchantAmount <= 0n) return undefined;

  return {
    networkFee,
    platformFee,
    merchantAmount,
  };
}

/**
 * Works out the payout for a deposit, all in wei.
 * Normally there are two transfers: one to the merchant and one to the platform.
 * If the deposit is too small for two transfers, or the platform fee would not even
 * cover its own transfer, the platform fee is dropped and the merchant gets
 * everything left after a single transfer fee.
 */
function prepareEthPayout(input: {
  totalAmount: bigint;
  merchantFeeRate: string;
  gasPrice: bigint;
}) {
  const { totalAmount, merchantFeeRate, gasPrice } = input;

  if (gasPrice <= 0n) throw new RangeError("Gas price must be positive");

  const singleTransactionFee = ETH_TRANSFER_GAS * gasPrice;

  if (totalAmount <= singleTransactionFee) return undefined;

  const payout = calculateMerchantPayout({
    totalAmount,
    networkFee: singleTransactionFee * 2n,
    merchantFeeRate,
  });

  if (!payout || payout.platformFee <= singleTransactionFee)
    return {
      networkFee: singleTransactionFee,
      platformFee: 0n,
      merchantAmount: totalAmount - singleTransactionFee,
    };

  return payout;
}

/**
 * Sends a signed transaction to the network and returns its hash.
 * Returns undefined when the node rejects it, including "already known" when it is sent again.
 */
async function broadcastEthTransaction(transactionHex: string) {
  const parsed = transactionIdSchema.safeParse(
    await post("eth_sendRawTransaction", [transactionHex]),
  );

  return parsed.success ? parsed.data.toLowerCase() : undefined;
}

/**
 * Looks up the receipt of a transaction.
 * - receipt:   the transaction is in a block (check `status` to see if it succeeded)
 * - null:      not in a block yet (still waiting, or dropped from the mempool)
 * - undefined: the lookup itself failed, so we do not know
 */
async function getEthTransactionReceipt(transactionId: string) {
  const data = await post("eth_getTransactionReceipt", [transactionId]);
  if (data === null) return null;

  const parsed = receiptSchema.safeParse(data);

  if (
    !parsed.success ||
    parsed.data.transactionHash.toLowerCase() !== transactionId
  )
    return undefined;

  return parsed.data;
}

/**
 * Pays out a confirmed ETH invoice from its deposit address. Runs in two steps:
 *
 * 1. "confirmed":  check the addresses and balance, sign the merchant and platform
 *    transfers, and save them with the invoice as it moves to "processing".
 * 2. "processing": send the saved transfers in nonce order and wait for their receipts.
 *    The invoice becomes "completed" only when every transfer is in a block and succeeded.
 *
 * Safe to call again at any time: after step 1 it only re-sends the same signed
 * transactions and never signs new ones.
 */
export async function transferEthToMerchant(
  invoiceId: string,
  platformAddress: string,
) {
  try {
    let invoice = await Invoice.findOne({
      invoice_id: invoiceId,
      crypto: "eth",
      status: { $in: ["confirmed", "processing"] },
    })
      .select("+private.private_key +tx.raw +tx.platform_raw")
      .exec();

    if (!invoice) return undefined;

    // Marks a confirmed invoice as failed. Only for problems that waiting will not fix.
    async function fail(reason: string) {
      await Invoice.updateOne(
        { invoice_id: invoiceId, status: "confirmed" },
        { $set: { status: "failed", "timestamps.failed": Date.now() } },
      ).exec();

      console.error("ETH payout failed:", invoiceId, reason);
    }

    // Make sure the node is Ethereum mainnet before trusting any balance or nonce from it.
    const chainId = await getEthQuantity("eth_chainId", []);

    if (chainId !== ETH_CHAIN_ID) {
      console.warn("Ethereum mainnet RPC is unavailable:", invoiceId);
      return;
    }

    // ─── Step 1: sign and save the payout (runs once per invoice) ──────────
    if (invoice.status === "confirmed") {
      if (invoice.to_crypto !== "eth" || invoice.fee_paid_by_payer)
        return await fail(
          "Only native ETH payouts with merchant-paid fees are supported",
        );

      const user = await User.findOne({ user_id: invoice.user_id })
        .select("merchant_fee")
        .exec();

      if (!user) return await fail("Merchant was not found");

      if (!invoice.private?.private_key)
        return await fail("Deposit private key is missing");

      // Every address must be a normal wallet. A contract runs code when it receives
      // ETH, which needs more than 21000 gas, so our transfer to it would fail.
      for (const address of [
        invoice.address,
        invoice.to_address,
        platformAddress,
      ]) {
        if (!isAddress(address) || BigInt(address) <= 0xffffn)
          return await fail(
            "Expected a valid wallet address outside the reserved address range",
          );

        const code = await getEthCode(address);

        // Lookup failed: try again on the next run.
        if (code === undefined) return;

        if (code !== "0x")
          return await fail(
            "Contract and delegated wallets are not supported by this payout flow",
          );
      }
      const depositAddress = getAddress(invoice.address);
      const merchantAddress = getAddress(invoice.to_address);
      const platformWalletAddress = getAddress(platformAddress);

      if (
        merchantAddress === depositAddress ||
        platformWalletAddress === depositAddress
      )
        return await fail(
          "Payout address must differ from the deposit address",
        );

      const feeRate = decimalStrToBigInt(user.merchant_fee, FEE_RATE_DECIMALS);

      if (feeRate === undefined || feeRate >= FEE_RATE_SCALE)
        return await fail("Invalid merchant fee rate");

      const totalAmount = await getEthBalance(depositAddress);

      const networkGasPrice = await getEthGasPrice();
      const gasPrice =
        networkGasPrice === undefined
          ? undefined
          : ceilDivide(networkGasPrice * GAS_PRICE_HEADROOM_PERCENT, 100n);

      const latestNonce = await getEthNonce(depositAddress, "latest");
      const pendingNonce = await getEthNonce(depositAddress, "pending");

      if (
        totalAmount === undefined ||
        gasPrice === undefined ||
        latestNonce === undefined ||
        pendingNonce === undefined
      ) {
        console.warn(
          "ETH payout is waiting for balance, gas price or nonce:",
          invoiceId,
        );
        return;
      }

      // A fresh deposit address has never sent anything. A nonce above 0 means something
      // was sent from it that the database does not know about, so stop for a manual check.
      if (latestNonce !== 0n || pendingNonce !== 0n) {
        console.error(
          "Deposit address has sent transactions the database does not know about:",
          invoiceId,
        );
        return;
      }

      if (totalAmount < BigInt(invoice.amount)) {
        console.warn(
          "ETH deposit balance is below the invoice amount:",
          invoiceId,
        );
        return;
      }
      // ─── Calculate outputs ──────────────────────────────────────────────

      const payout = prepareEthPayout({
        totalAmount,
        merchantFeeRate: user.merchant_fee,
        gasPrice,
      });

      if (!payout) {
        console.warn("ETH payout is too small after fees:", invoiceId);
        return;
      }

      const wallet = new Wallet(
        openSecret("ethereum-deposit-key", invoice.private.private_key),
      );

      // The key must belong to the deposit address before we sign anything with it.
      if (wallet.address !== depositAddress)
        return await fail("Deposit address and private key do not match");

      // ─── Build & sign transaction ───────────────────────────────────────

      // Sign both transfers now, but do not send them yet.
      // Legacy (type 0) transactions charge exactly gasPrice, so the fee is known in advance.
      const transactionHex = await wallet.signTransaction({
        type: 0,
        chainId: ETH_CHAIN_ID,
        nonce: MERCHANT_NONCE,
        to: merchantAddress,
        value: payout.merchantAmount,
        gasLimit: ETH_TRANSFER_GAS,
        gasPrice,
      });

      // A transaction's hash is the keccak256 of its signed bytes.
      const transactionId = keccak256(transactionHex);

      let platformTransactionHex = "";
      let platformTransactionId = "";

      if (payout.platformFee > 0n) {
        platformTransactionHex = await wallet.signTransaction({
          type: 0,
          chainId: ETH_CHAIN_ID,
          nonce: PLATFORM_NONCE,
          to: platformWalletAddress,
          value: payout.platformFee,
          gasLimit: ETH_TRANSFER_GAS,
          gasPrice,
        });

        platformTransactionId = keccak256(platformTransactionHex);
      }

      // ─── Save transaction to db ───────────────────────────────────────

      // Save the signed transfers and move to "processing" in one update. Only one run
      // can win this, so a payout is never signed twice with different amounts.
      invoice = await Invoice.findOneAndUpdate(
        { invoice_id: invoiceId, status: "confirmed" },
        {
          $set: {
            status: "processing",
            "timestamps.processing": Date.now(),
            "tx.out": transactionId,
            "tx.raw": transactionHex,
            "tx.platform_out": platformTransactionId,
            "tx.platform_raw": platformTransactionHex,
            received_amount: payout.merchantAmount.toString(),
            network_fee: payout.networkFee.toString(),
            platform_fee: payout.platformFee.toString(),
          },
        },
        {
          returnDocument: "after",
        },
      )
        .select("+tx.raw +tx.platform_raw")
        .exec();

      if (!invoice) return undefined;
    }

    // ─── Step 2: send the saved transfers and wait for them to be mined ───
    if (!invoice.tx?.out || !invoice.tx.raw) {
      console.error(
        "Processing invoice has no saved ETH transaction:",
        invoiceId,
      );
      return;
    }

    // Merchant first (nonce 0), then platform (nonce 1).
    const transactions = [
      { name: "merchant", id: invoice.tx.out, raw: invoice.tx.raw },
    ];

    if (BigInt(invoice.platform_fee) > 0n) {
      if (!invoice.tx.platform_out || !invoice.tx.platform_raw) {
        console.error(
          "Processing invoice has no saved platform transaction:",
          invoiceId,
        );
        return;
      }

      transactions.push({
        name: "platform",
        id: invoice.tx.platform_out,
        raw: invoice.tx.platform_raw,
      });
    }

    let actualNetworkFee = 0n;

    for (const transaction of transactions) {
      const receipt = await getEthTransactionReceipt(transaction.id);

      // Lookup failed: try again on the next run.
      if (receipt === undefined) return;

      // ─── Broadcast ──────────────────────────────────────────────────────

      // Not in a block yet. Sending the same signed transaction again is safe:
      // it has the same nonce and hash, so it can never be paid twice.
      if (receipt === null) {
        const broadcastId = await broadcastEthTransaction(transaction.raw);

        if (broadcastId === transaction.id) {
          console.log(
            "ETH payout broadcast:",
            invoiceId,
            transaction.name,
            transaction.id,
          );
        } else {
          console.warn(
            "ETH broadcast is unconfirmed; keep processing:",
            invoiceId,
            transaction.id,
          );
        }
        // Wait for a receipt before sending the next transaction.
        return;
      }

      // What this transfer really cost: gas used × price per gas.
      actualNetworkFee +=
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);

      // "0x0" means reverted: the transfer is in a block and its gas was paid, but no ETH moved.
      if (receipt.status !== "0x1") {
        // The merchant was paid; only the fee transfer failed, and that ETH stays at the deposit address.
        if (transaction.name === "platform") {
          await Invoice.updateOne(
            {
              invoice_id: invoiceId,
              status: "processing",
              "tx.out": invoice.tx.out,
            },
            {
              $set: {
                status: "completed",
                "timestamps.completed": Date.now(),
                network_fee: actualNetworkFee.toString(),
                review_reason:
                  "Platform fee transfer reverted; funds remain at the deposit address",
              },
            },
          ).exec();
          console.error(
            "ETH platform fee transaction reverted; merchant was paid:",
            invoiceId,
            transaction.id,
          );
          return;
        }

        // The merchant transfer failed, so the platform transfer was never sent.
        // The ETH is still at the deposit address, minus this transfer's gas.
        await Invoice.updateOne(
          {
            invoice_id: invoiceId,
            status: "processing",
            "tx.out": invoice.tx.out,
          },
          {
            $set: {
              status: "failed",
              "timestamps.failed": Date.now(),
              received_amount: "0",
              platform_fee: "0",
              network_fee: actualNetworkFee.toString(),
            },
          },
        ).exec();
        console.error(
          "ETH merchant transaction reverted; manual review required:",
          invoiceId,
          transaction.id,
        );
        return;
      }
    }

    // Every transfer is in a block and succeeded.
    const update = await Invoice.updateOne(
      {
        invoice_id: invoiceId,
        status: "processing",
        "tx.out": invoice.tx.out,
      },
      {
        $set: {
          status: "completed",
          "timestamps.completed": Date.now(),
          network_fee: actualNetworkFee.toString(),
        },
      },
    ).exec();

    if (update.modifiedCount > 0)
      console.log("ETH payout completed:", invoiceId, invoice.tx.out);
  } catch (error) {
    // Leave the invoice as it is; the next run picks it up again.
    // Log only the message, never the whole error object.
    console.error(
      "ETH payout could not finish; invoice state was preserved:",
      invoiceId,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}
