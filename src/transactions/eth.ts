import { z } from "zod";
import { env } from "../config/env.js";
import { ceilDivide } from "../money/format.js";
import { parseFeeRate, splitPayout } from "../money/payout-split.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { getAddress, isAddress, keccak256, Wallet } from "ethers";
import { openSecret } from "../security/secret-envelope.js";

const ETH_CHAIN_ID = 1n;
const ETH_TRANSFER_GAS = 21_000n;

// Increase the suggested legacy gas price by 25%.
// This increases the actual fee and does not guarantee inclusion.
const GAS_PRICE_HEADROOM_PERCENT = 125n;

const MERCHANT_NONCE = 0;
const PLATFORM_NONCE = 1;

const STUCK_TX_REVIEW_MS = 24 * 60 * 60 * 1000;
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
      console.warn("ETH RPC HTTP failed:", method, res.status);
      return undefined;
    }

    const body: unknown = await res.json();

    const rpcError = z
      .object({
        error: z.object({ code: z.number(), message: z.string() }),
      })
      .safeParse(body);

    if (rpcError.success) {
      console.warn(
        "ETH rpc error",
        method,
        rpcError.data?.error.code,
        rpcError.data?.error.message,
      );
      return undefined;
    }

    const rpcResult = z.object({ result: z.unknown() }).safeParse(body);
    return rpcResult.success ? rpcResult.data.result : undefined;
  } catch (error) {
    console.warn(
      "ETH RPC request failed:",
      method,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

async function getEthQuantity(method: string, params: unknown[]) {
  const parsed = z
    .string()
    .regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/)
    .safeParse(await post(method, params));
  return parsed.success ? BigInt(parsed.data) : undefined;
}

async function getEthBalance(address: string) {
  return await getEthQuantity("eth_getBalance", [address, "latest"]);
}

async function getEthGasPrice() {
  const gas = await getEthQuantity("eth_gasPrice", []);
  return gas !== undefined && gas > 0n ? gas : undefined;
}

async function getEthNonce(address: string, block: "latest" | "pending") {
  return await getEthQuantity("eth_getTransactionCount", [address, block]);
}

async function getEthCode(address: string) {
  const parsed = z
    .string()
    .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
    .safeParse(await post("eth_getCode", [address, "latest"]));

  return parsed.success ? parsed.data : undefined;
}

async function broadcastEthTx(hex: string) {
  const parsed = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .safeParse(await post("eth_sendRawTransaction", [hex]));

  return parsed.success ? parsed.data : undefined;
}

// 0x0 is completed but fund revert, rather than fail
async function getEthTxReceipt(txId: string) {
  const res = await post("eth_getTransactionReceipt", [txId]);
  if (res === null) return null;
  const receiptSchema = z.object({
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    blockNumber: z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/),
    status: z.enum(["0x0", "0x1"]), // "0x1" = success, "0x0" = reverted
    gasUsed: z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/), // gas actually used; 21000 for a plain transfer
    effectiveGasPrice: z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/), // price actually paid per gas, in wei
  });

  const parsed = receiptSchema.safeParse(res);

  if (!parsed.success || parsed.data.transactionHash.toLowerCase() !== txId)
    return undefined;

  return parsed.data;
}

function decideTransferCount(input: {
  balance: bigint;
  gasPrice: bigint;
  feeRate: bigint;
}): { platformFee: bigint; merchantAmount: bigint } | undefined {
  const { balance, feeRate, gasPrice } = input;

  // No platform transfer at a 0% rate, so only one transfer's gas.
  const transfers = feeRate === 0n ? 1n : 2n;
  const split = splitPayout({
    received: balance,
    networkCost: gasPrice * ETH_TRANSFER_GAS * transfers,
    feeRate,
  });
  if (split === undefined) return undefined;

  return split;
}

function prepareEthPayout(input: {
  chainId: bigint;
  merchantAddress: string;
  platformAddress: string;
  balance: bigint;
  gasPrice: bigint;
  feeRate: bigint;
}):
  | {
      chainId: bigint;
      nonce: number;
      to: string;
      value: bigint;
      gasPrice: bigint;
    }[]
  | undefined {
  const {
    chainId,
    merchantAddress,
    platformAddress,
    balance,
    gasPrice,
    feeRate,
  } = input;
  if (chainId !== 1n) return;
  if (!isAddress(merchantAddress)) {
    return;
  }
  if (!isAddress(platformAddress)) return undefined;
  if (input.gasPrice <= 0n) return undefined;

  const count = decideTransferCount({ balance, gasPrice, feeRate });
  if (count === undefined) return undefined;

  let payout = [
    {
      chainId,
      nonce: MERCHANT_NONCE,
      to: merchantAddress,
      value: count.merchantAmount,
      gasPrice,
    },
  ];

  if (count.platformFee > 0n) {
    payout.push({
      chainId,
      nonce: PLATFORM_NONCE,
      to: platformAddress,
      value: count.platformFee,
      gasPrice,
    });
  }

  return payout;
}

async function sign(
  wallet: Wallet,
  txs: {
    chainId: bigint;
    nonce: number;
    to: string;
    value: bigint;
    gasPrice: bigint;
  }[],
): Promise<{ nonce: number; transactionHex: string; transactionId: string }[]> {
  const signed = [];
  for (const tx of txs) {
    const hex = await wallet.signTransaction({
      ...tx,
      type: 0,
      gasLimit: ETH_TRANSFER_GAS,
    });

    signed.push({
      nonce: tx.nonce,
      transactionHex: hex,
      transactionId: keccak256(hex),
    });
  }

  return signed;
}

async function transferEthToMerchant(
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

    async function fail(reason: string) {
      const result = await Invoice.updateOne(
        { invoice_id: invoiceId, status: "confirmed" },
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
          "ETH payout: could not mark failed, invoice is no longer confirmed:",
          invoiceId,
          reason,
        );
        return;
      }
      console.error("Eth payout failed:", invoiceId, reason);
    }

    if (invoice.status === "confirmed") {
      const user = await User.findOne({ user_id: invoice.user_id })
        .select("merchant_fee")
        .exec();

      if (!user) {
        await fail(
          `Payout stopped: merchant account ${invoice.user_id} was not found. All funds are still at deposit address ${invoice.address}. Check whether the merchant was deleted, then pay out manually.`,
        );
        return;
      }

      if (!invoice.private?.private_key) {
        await fail(
          `Payout stopped: the deposit private key is missing from the database. All funds are still at deposit address ${invoice.address}. Restore the key from backup; without it the funds cannot be moved.`,
        );
        return;
      }

      const merchantAddress = invoice.to_address;
      const networkGasPrice = await getEthGasPrice();
      if (networkGasPrice === undefined) {
        console.warn("Eth gas price unavailable: will retry:", invoiceId);
        return;
      }
      const gasPrice = ceilDivide(
        networkGasPrice * GAS_PRICE_HEADROOM_PERCENT,
        100n,
      );
      const merchantFeeRate = user.merchant_fee;
      const feeRate = parseFeeRate(merchantFeeRate);
      if (feeRate === undefined) {
        await fail(
          `Payout stopped: merchant fee rate "${merchantFeeRate}" is not a valid rate below 100%. All funds are still at deposit address ${invoice.address}. Fix merchant_fee (e.g. "0.005" = 0.5%), then pay out manually.`,
        );
        return;
      }
      const balance = await getEthBalance(invoice.address);
      if (balance === undefined) {
        console.warn("ETH balances unavailable; will retry:", invoiceId);
        return;
      }
      if (balance < BigInt(invoice.amount)) {
        await fail(
          `Payout stopped: balance ${balance} wei is below the invoice amount ${invoice.amount} wei, although the invoice is confirmed. Funds still at deposit address ${invoice.address}: ${balance} wei. Check on a block explorer whether the payment was replaced or reorged.`,
        );
        return;
      }

      if (!isAddress(merchantAddress)) {
        await fail(
          `Payout stopped: merchant payout address "${merchantAddress}" is not a valid Ethereum address. All funds are still at deposit address ${invoice.address}. Fix the merchant's ETH address, then pay out manually.`,
        );
        return;
      }

      if (getAddress(merchantAddress) === getAddress(invoice.address)) {
        await fail(
          `Payout stopped: merchant payout address is the deposit address itself (${invoice.address}). All funds are still there. Fix the merchant's ETH address, then pay out manually.`,
        );
        return;
      }

      const latestNonce = await getEthNonce(invoice.address, "latest");
      const pendingNonce = await getEthNonce(invoice.address, "pending");
      if (latestNonce === undefined || pendingNonce === undefined) {
        console.warn(
          "Could not get deposit address nonce; will retry:",
          invoiceId,
        );
        return;
      }

      if (latestNonce !== 0n || pendingNonce !== 0n) {
        await fail(
          `Payout stopped: deposit address ${invoice.address} has already sent a transaction (latest nonce ${latestNonce}, pending nonce ${pendingNonce}), but this invoice has no saved payout. Funds may have moved. Check the address on a block explorer before doing anything.`,
        );
        return;
      }

      const payout = prepareEthPayout({
        chainId: ETH_CHAIN_ID,
        merchantAddress,
        platformAddress,
        balance,
        gasPrice,
        feeRate,
      });

      if (payout === undefined) {
        console.warn(
          "Could not prepare the payout will try next round",
          invoiceId,
        );
        return;
      }

      const wallet = new Wallet(
        openSecret("ethereum-deposit-key", invoice.private.private_key),
      );

      if (getAddress(wallet.address) !== getAddress(invoice.address)) {
        await fail(
          `Payout stopped: the stored key opens ${wallet.address}, not deposit address ${invoice.address}. All funds are still at the deposit address. Do not retry; investigate the key storage.`,
        );
        return;
      }

      const merchantCode = await getEthCode(merchantAddress);
      if (merchantCode === undefined) {
        console.warn("ETH code lookup unavailable; will retry:", invoiceId);
        return;
      }

      if (merchantCode !== "0x") {
        await fail(
          `Payout stopped: merchant address ${merchantAddress} is a contract or delegated wallet and cannot receive a 21,000-gas transfer. All funds are still at deposit address ${invoice.address}. Ask the merchant for a normal wallet address, then pay out manually.`,
        );
        return;
      }

      const signedTxs = await sign(wallet, payout);

      const merchantTx = signedTxs.find((t) => t.nonce === MERCHANT_NONCE);
      if (merchantTx === undefined) {
        throw new Error(
          "Bug: signed txs are missing the merchant tx (nonce 0)",
        );
      }
      const platformTx = signedTxs.find((t) => t.nonce === PLATFORM_NONCE);

      const merchantPayout = payout.find((t) => t.nonce === MERCHANT_NONCE);
      if (merchantPayout === undefined) {
        throw new Error("Bug: payout is missing the merchant tx (nonce 0)");
      }
      const platformPayout = payout.find((t) => t.nonce === PLATFORM_NONCE);
      let platformFee: bigint;
      if (platformPayout === undefined) {
        platformFee = 0n;
      } else {
        platformFee = platformPayout.value;
      }

      const networkFee = balance - merchantPayout.value - platformFee;

      invoice = await Invoice.findOneAndUpdate(
        { invoice_id: invoiceId, status: "confirmed", crypto: "eth" },
        {
          $set: {
            status: "processing",
            "timestamps.processing": Date.now(),
            "tx.out": merchantTx.transactionId,
            "tx.raw": merchantTx.transactionHex,
            ...(platformTx !== undefined && {
              "tx.platform_out": platformTx.transactionId,
              "tx.platform_raw": platformTx.transactionHex,
            }),
            received_amount: merchantPayout.value.toString(),
            network_fee: networkFee.toString(),
            platform_fee: platformFee.toString(),
          },
        },
        {
          returnDocument: "after",
        },
      )
        .select("+tx.raw +tx.platform_raw")
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
        { invoice_id: invoiceId, status: "processing" },
        {
          $set: {
            review_reason: `Invoice is processing but has no saved merchant transaction. The claim always saves it, so this is a bug or a manual DB edit. Funds may still be at deposit address ${invoice.address}; check a block explorer before resending anything.`,
          },
        },
      ).exec();
      console.error(
        "ETH invoice is processing but has no saved tx; needs review:",
        invoiceId,
      );
      return;
    }

    const txs = [{ nonce: MERCHANT_NONCE, id: txId, raw: hex }];

    if (BigInt(invoice.platform_fee) > 0n) {
      if (!invoice.tx?.platform_out || !invoice.tx?.platform_raw) {
        await Invoice.updateOne(
          { invoice_id: invoiceId, status: "processing" },
          {
            $set: {
              review_reason: `Invoice is processing with a platform fee, but has no saved platform transaction. The claim always saves it, so this is a bug or a manual DB edit. The platform fee may still be at deposit address ${invoice.address}; check a block explorer before resending anything.`,
            },
          },
        ).exec();
        console.error(
          "ETH invoice is processing but has no saved platform tx; needs review:",
          invoiceId,
        );
        return;
      }
      txs.push({
        nonce: PLATFORM_NONCE,
        id: invoice.tx.platform_out,
        raw: invoice.tx.platform_raw,
      });
    }

    let actualNetworkFee = 0n;

    for (const tx of txs) {
      const receipt = await getEthTxReceipt(tx.id);
      if (receipt === undefined) {
        console.warn(
          "ETH receipt lookup failed; will retry:",
          invoiceId,
          tx.id,
        );
        return;
      }

      if (receipt === null) {
        const broadcastId = await broadcastEthTx(tx.raw);

        if (broadcastId === tx.id) {
          console.log("ETH payout broadcast:", invoiceId, tx.id);
        } else {
          console.warn(
            "ETH broadcast unconfirmed; keep processing:",
            invoiceId,
            tx.id,
          );
        }

        const processingAt = invoice.timestamps?.processing;

        if (
          processingAt != null &&
          Date.now() - processingAt >= STUCK_TX_REVIEW_MS
        ) {
          const reason =
            tx.nonce === PLATFORM_NONCE
              ? `Merchant was paid, but platform transfer ${tx.id} has no receipt yet and the payout has been processing for over 24 hours. The platform fee is still at deposit address ${invoice.address}. Keep waiting; review if this continues.`
              : `Merchant transfer ${tx.id} has no receipt after 24 hours. The merchant has not been paid yet. Funds are still at deposit address ${invoice.address}. Keep waiting; review if this continues.`;

          const result = await Invoice.updateOne(
            {
              invoice_id: invoiceId,
              status: "processing",
              review_reason: { $ne: reason },
            },
            { $set: { review_reason: reason } },
          ).exec();

          if (result.modifiedCount === 1) {
            console.error("ETH payout stuck; needs review:", invoiceId, tx.id);
          }
        }

        return;
      }
      // What this transfer really cost: gas used × price per gas.
      actualNetworkFee +=
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);

      if (receipt.status === "0x0") {
        if (tx.nonce === PLATFORM_NONCE) {
          await Invoice.updateOne(
            {
              invoice_id: invoiceId,
              status: "processing",
              "tx.platform_out": tx.id,
            },
            {
              $set: {
                status: "completed",
                "timestamps.completed": Date.now(),
                network_fee: actualNetworkFee.toString(),

                review_reason: `Platform fee transfer ${tx.id} reverted: its gas was paid, but no ETH moved. The merchant was paid. The platform fee (${invoice.platform_fee} wei) is still at deposit address ${invoice.address}. Send the platform fee manually.`,
              },
            },
          ).exec();
          console.error(
            "ETH platform fee transaction reverted; merchant was paid:",
            invoiceId,
            tx.id,
          );
          return;
        }

        await Invoice.updateOne(
          {
            invoice_id: invoiceId,
            status: "processing",
            "tx.out": txId,
          },
          {
            $set: {
              status: "failed",
              "timestamps.failed": Date.now(),
              received_amount: "0",
              platform_fee: "0",
              // Only this transfer was mined, so only its gas was spent.
              network_fee: actualNetworkFee.toString(),
              review_reason: `Merchant transfer ${tx.id} reverted: its gas was paid, but no ETH moved. The platform transfer (nonce 1) was never sent. Funds are still at deposit address ${invoice.address}. Check why the merchant address rejected the transfer, then pay out manually.`,
            },
          },
        ).exec();
        console.error(
          "ETH merchant transaction reverted; manual review required:",
          invoiceId,
          tx.id,
        );
        return;
      }
    }

    const update = await Invoice.updateOne(
      { invoice_id: invoiceId, status: "processing", "tx.out": txId },
      {
        $set: {
          status: "completed",
          "timestamps.completed": Date.now(),
          review_reason: "",
        },
      },
    ).exec();

    if (update.modifiedCount > 0)
      console.log("ETH payout completed:", invoiceId, txId);
  } catch (error) {
    console.error(
      "ETH payout could not finish; invoice state was preserved:",
      invoiceId,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}
