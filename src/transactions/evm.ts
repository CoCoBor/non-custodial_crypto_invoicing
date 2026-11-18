import { AbiCoder, getAddress, id, isAddress, keccak256, Transaction, Wallet } from "ethers";
import { z } from "zod";

import type { AssetId } from "../assets/payout-address.js";
import type { PayoutRequest, PayoutResult, Transfer } from "../chains/adapter.js";
import type { EvmRpc } from "../chains/evm-rpc.js";
import { decimalStrToBigInt } from "../invoice/money.function.js";
import { ceilDivide } from "../money/format.js";
import { splitPayout } from "../money/payout-split.js";
import { openSecret, type SealedSecret, type SecretPurpose } from "../security/secret-envelope.js";

// Payouts from an EVM deposit (Ethereum, BNB Smart Chain), in the native
// coin or in an ERC-20/BEP-20 token. Legacy (type 0) transactions with an
// EIP-155 chain id: the price per gas is fixed, so a payout's network cost
// is known before it is sent.
//
// A token deposit holds no native coin. The chain's gas wallet first sends
// it exactly the gas the two token transfers may use (gas_top_up). What the
// gas wallet spent is converted to token units at the current prices and
// taken from the merchant's share: it rides on the platform's token transfer.

export type EvmChain = {
  /** Names the chain in messages, e.g. "ETH". */
  label: string;
  chainId: bigint;
  nativeAsset: AssetId;
  /** A price per gas above this means the node is broken: wait instead of paying it. */
  maxGasPrice: bigint;
  gasWalletPurpose: SecretPurpose;
  /**
   * A saved transaction is called lost only once another transaction used its
   * nonce at least this many blocks ago. Below 128, so a full node still holds
   * the state at that block.
   */
  lostAfterBlocks: bigint;
};

export type EvmToken = { asset: AssetId; contract: string; decimals: number };

/** USD price of an asset as decimal text, or undefined when unavailable (src/invoice/price.function.ts). */
export type PricePort = (asset: AssetId, currency: "usd") => Promise<string | undefined>;

export type EvmPayoutDeps = {
  chain: EvmChain;
  rpc: EvmRpc;
  /** Our own config: a missing one makes the payout wait with a review note. */
  platformAddress: string | undefined;
};

export type EvmTokenPayoutDeps = EvmPayoutDeps & {
  token: EvmToken;
  gasWalletKey: SealedSecret | undefined;
  getPrice: PricePort;
};

const TRANSFER_GAS = 21_000n;
// Gas limit of each token transfer. Ethereum USDT and USDC use about 41k to
// 65k (more when the receiver held none before). Unused gas stays at the
// deposit as native coin; the next payout from it tops up less.
export const TOKEN_TRANSFER_GAS_LIMIT = 100_000n;
// Over the node's suggested price. It raises the fee; it does not guarantee inclusion.
const GAS_PRICE_HEADROOM_PERCENT = 125n;
const NATIVE_DECIMALS = 18;
const PRICE_DECIMALS = 10;

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const TRANSFER_SELECTOR = id("transfer(address,uint256)").slice(0, 10);
const BALANCE_OF_SELECTOR = id("balanceOf(address)").slice(0, 10);

const hexQuantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

// ---------- JSON-RPC reads ----------

async function quantity(rpc: EvmRpc, method: string, params: unknown[]): Promise<bigint | undefined> {
  const parsed = hexQuantity.safeParse(await rpc.call(method, params));
  return parsed.success ? BigInt(parsed.data) : undefined;
}

async function gasPriceToPay(rpc: EvmRpc, chain: EvmChain): Promise<bigint | undefined> {
  const suggested = await quantity(rpc, "eth_gasPrice", []);
  if (suggested === undefined || suggested <= 0n) return undefined;
  const price = ceilDivide(suggested * GAS_PRICE_HEADROOM_PERCENT, 100n);
  if (price > chain.maxGasPrice) {
    console.warn(`${chain.label} gas price is above the sanity cap:`, price);
    return undefined;
  }
  return price;
}

const nativeBalance = (rpc: EvmRpc, address: string) => quantity(rpc, "eth_getBalance", [address, "latest"]);
const nonceOf = (rpc: EvmRpc, address: string, block: "latest" | "pending") =>
  quantity(rpc, "eth_getTransactionCount", [address, block]);

async function tokenBalance(rpc: EvmRpc, contract: string, owner: string): Promise<bigint | undefined> {
  const data = BALANCE_OF_SELECTOR + AbiCoder.defaultAbiCoder().encode(["address"], [owner]).slice(2);
  const parsed = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .safeParse(await rpc.call("eth_call", [{ to: contract, data }, "latest"]));
  return parsed.success ? BigInt(parsed.data) : undefined;
}

async function codeAt(rpc: EvmRpc, address: string): Promise<string | undefined> {
  const parsed = z
    .string()
    .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
    .safeParse(await rpc.call("eth_getCode", [address, "latest"]));
  return parsed.success ? parsed.data : undefined;
}

const receiptSchema = z.object({
  transactionHash: txHash,
  status: z.enum(["0x0", "0x1"]),
  logs: z.array(
    z.object({
      address: z.string(),
      topics: z.array(z.string()),
      data: z.string(),
      removed: z.boolean().optional(),
    }),
  ),
});
type Receipt = z.infer<typeof receiptSchema>;

/** null: the node knows no receipt (not mined, or unknown). undefined: the lookup failed. */
async function receiptOf(rpc: EvmRpc, txid: string): Promise<Receipt | null | undefined> {
  const reply = await rpc.call("eth_getTransactionReceipt", [txid]);
  if (reply === null) return null;
  const parsed = receiptSchema.safeParse(reply);
  if (!parsed.success || parsed.data.transactionHash.toLowerCase() !== txid) return undefined;
  return parsed.data;
}

/** undefined: the lookup failed. */
async function transactionKnown(rpc: EvmRpc, txid: string): Promise<boolean | undefined> {
  const reply = await rpc.call("eth_getTransactionByHash", [txid]);
  if (reply === null) return false;
  const parsed = z.object({ hash: txHash }).safeParse(reply);
  if (!parsed.success || parsed.data.hash.toLowerCase() !== txid) return undefined;
  return true;
}

type SavedTxFate =
  | { fate: "mined"; receipt: Receipt }
  | { fate: "can_land" }
  | { fate: "wait"; reason: string }
  | { fate: "lost" };

/**
 * What became of a saved transaction from `sender`. "lost" needs proof: its
 * nonce was already used `lostAfterBlocks` blocks ago and, read after that,
 * the node knows neither its receipt nor the transaction. A nonce used more
 * recently may be our own transaction whose receipt the node can't serve yet
 * (a load-balanced provider's node behind the one that answered the nonce;
 * anvil under load).
 */
async function savedTxFate(rpc: EvmRpc, chain: EvmChain, tx: SignedTx, sender: string): Promise<SavedTxFate> {
  const wait = (reason: string): SavedTxFate => ({ fate: "wait", reason });
  const receipt = await receiptOf(rpc, tx.txid);
  if (receipt === undefined) return wait(`${chain.label} receipt lookup failed`);
  if (receipt !== null) return { fate: "mined", receipt };

  const latest = await nonceOf(rpc, sender, "latest");
  if (latest === undefined) return wait(`${chain.label} nonce of ${sender} unavailable`);
  // A saved transfer can land only while its nonce is unused.
  if (BigInt(tx.nonce) >= latest) return { fate: "can_land" };

  const head = await quantity(rpc, "eth_blockNumber", []);
  if (head === undefined) return wait(`${chain.label} block number unavailable`);
  const recent = wait(`nonce ${tx.nonce} of ${sender} was used in the last ${chain.lostAfterBlocks} blocks; waiting for the receipt of ${tx.txid}`);
  if (head < chain.lostAfterBlocks) return recent;
  const usedLongAgo = await quantity(rpc, "eth_getTransactionCount", [sender, "0x" + (head - chain.lostAfterBlocks).toString(16)]);
  if (usedLongAgo === undefined) return wait(`${chain.label} nonce of ${sender} at an older block unavailable`);
  if (BigInt(tx.nonce) >= usedLongAgo) return recent;

  const again = await receiptOf(rpc, tx.txid);
  if (again === undefined) return wait(`${chain.label} receipt lookup failed`);
  if (again !== null) return { fate: "mined", receipt: again };
  const known = await transactionKnown(rpc, tx.txid);
  if (known === undefined) return wait(`${chain.label} transaction lookup failed`);
  if (known) return wait(`${tx.txid} is known to the node but has no receipt yet`);
  return { fate: "lost" };
}

async function broadcast(rpc: EvmRpc, chain: EvmChain, signed: SignedTx): Promise<void> {
  const parsed = txHash.safeParse(await rpc.call("eth_sendRawTransaction", [signed.raw]));
  if (parsed.success && parsed.data.toLowerCase() === signed.txid) {
    console.log(`${chain.label} payout transaction broadcast:`, signed.txid);
  }
  // A failed broadcast is already logged by the RPC client ("already known",
  // "nonce too low" after it landed, ...). The receipt decides, next round.
}

// ---------- Signing ----------

const signedTxSchema = z.object({
  kind: z.enum(["gas_top_up", "merchant_payout", "platform_fee", "refund_route", "swap_deposit"]),
  to: z.string(),
  amount: z.string().regex(/^[0-9]+$/),
  nonce: z.number().int().nonnegative(),
  raw: z.string().regex(/^0x[0-9a-fA-F]+$/),
  txid: txHash,
});
type SignedTx = z.infer<typeof signedTxSchema>;

async function signTx(
  wallet: Wallet,
  chain: EvmChain,
  tx: { kind: Transfer["kind"]; recipient: string; nonce: bigint; gasPrice: bigint } & (
    | { value: bigint }
    | { token: EvmToken; tokenAmount: bigint }
  ),
): Promise<SignedTx> {
  const isToken = "token" in tx;
  const raw = await wallet.signTransaction({
    type: 0,
    chainId: chain.chainId,
    nonce: Number(tx.nonce),
    gasPrice: tx.gasPrice,
    gasLimit: isToken ? TOKEN_TRANSFER_GAS_LIMIT : TRANSFER_GAS,
    to: isToken ? tx.token.contract : tx.recipient,
    value: isToken ? 0n : tx.value,
    data: isToken
      ? TRANSFER_SELECTOR + AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [tx.recipient, tx.tokenAmount]).slice(2)
      : "0x",
  });
  return {
    kind: tx.kind,
    to: getAddress(tx.recipient),
    amount: (isToken ? tx.tokenAmount : tx.value).toString(),
    nonce: Number(tx.nonce),
    raw,
    txid: keccak256(raw).toLowerCase(),
  };
}

const asTransfer = (t: SignedTx): Transfer => ({ kind: t.kind, to: t.to, amount: BigInt(t.amount), txid: t.txid });

// ---------- Checkpoint state ----------

const stateSchema = z.discriminatedUnion("mode", [
  z.object({ v: z.literal(1), mode: z.literal("native"), txs: z.array(signedTxSchema).min(1) }),
  z.object({
    v: z.literal(1),
    mode: z.literal("token"),
    // "top_up": waiting for the gas top-up; "transfers": the deposit's token transfers may be sent.
    phase: z.enum(["top_up", "transfers"]),
    gasPrice: z.string().regex(/^[0-9]+$/),
    gasWallet: z.string(),
    topUp: signedTxSchema.optional(),
    txs: z.array(signedTxSchema).min(1),
  }),
]);
type PayoutState = z.infer<typeof stateSchema>;
type TokenState = Extract<PayoutState, { mode: "token" }>;

function readState(text: string): PayoutState | undefined {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ---------- Shared checks ----------

function isValidEvmAddress(address: string): boolean {
  return isAddress(address) && BigInt(address) !== 0n;
}

type Prepared = { wallet: Wallet; gasPrice: bigint; nonce: bigint };

/**
 * Everything both payouts check before planning. A PayoutResult answer
 * ends the payout there.
 */
async function prepare(
  request: PayoutRequest,
  deps: EvmPayoutDeps,
  ownAsset: AssetId,
): Promise<Prepared | PayoutResult> {
  const { chain, rpc } = deps;
  const { depositAddress, destination } = request;
  const fail = (reason: string): PayoutResult => ({
    status: "failed",
    message: `${chain.label} payout stopped: ${reason}. Nothing was sent: all funds are still at deposit address ${depositAddress}. Fix the cause, then set the invoice back to "confirmed" to retry, or move the funds by hand with the deposit key.`,
    transfers: [],
  });

  if (deps.platformAddress === undefined || !isValidEvmAddress(deps.platformAddress)) {
    return {
      status: "pending",
      reason: `platform ${chain.label} address is not configured`,
      review: `The platform ${chain.label} address is not configured, so this payout waits. Nothing was sent: the funds are still at deposit address ${depositAddress}. Set it in the server config.`,
    };
  }
  if (request.receiveAsset !== ownAsset) return fail(`a ${ownAsset} deposit can't be paid out as ${request.receiveAsset}`);
  if (!isValidEvmAddress(destination)) return fail(`destination "${destination}" is not a valid ${chain.label} address`);
  if (getAddress(destination) === getAddress(depositAddress)) return fail("the destination is the deposit address itself");
  if (request.depositKey.kind !== "sealed_key") return fail("the deposit private key is missing");

  let wallet: Wallet;
  try {
    wallet = new Wallet(openSecret("ethereum-deposit-key", request.depositKey.sealed));
  } catch {
    return fail("the stored deposit key can't be opened");
  }
  if (getAddress(wallet.address) !== getAddress(depositAddress)) {
    return fail(`the stored key opens ${wallet.address}, not the deposit address. Do not retry; investigate the key storage`);
  }

  const chainId = await quantity(rpc, "eth_chainId", []);
  if (chainId === undefined) return { status: "pending", reason: `${chain.label} chain id unavailable` };
  if (chainId !== chain.chainId) {
    return {
      status: "pending",
      reason: `${chain.label} node is on chain ${chainId}`,
      review: `The ${chain.label} node answers for chain id ${chainId}, not ${chain.chainId}. Nothing was sent; fix the node URL.`,
    };
  }

  const gasPrice = await gasPriceToPay(rpc, chain);
  if (gasPrice === undefined) return { status: "pending", reason: `${chain.label} gas price unavailable` };

  const [latest, pending] = await Promise.all([nonceOf(rpc, depositAddress, "latest"), nonceOf(rpc, depositAddress, "pending")]);
  if (latest === undefined || pending === undefined) return { status: "pending", reason: "deposit nonce unavailable" };
  if (latest !== pending) {
    return {
      status: "pending",
      reason: "the deposit has a transaction in flight",
      review: `Deposit address ${depositAddress} has a transaction in flight (nonce ${latest}, pending ${pending}) that no saved payout knows. Funds may be moving; check the address on a block explorer before doing anything.`,
    };
  }

  return { wallet, gasPrice, nonce: latest };
}

/**
 * Follows the deposit's saved transfers: re-sends the same signed bytes while
 * they can still land, and proves them by their receipts.
 */
async function followDepositTransfers(
  request: PayoutRequest,
  deps: EvmPayoutDeps,
  txs: SignedTx[],
  proof: (tx: SignedTx, receipt: Receipt) => bigint,
  alreadyMoved: Transfer[],
): Promise<PayoutResult> {
  const { chain, rpc } = deps;
  const { depositAddress } = request;
  const moved: Transfer[] = [...alreadyMoved];
  const notes: string[] = [];
  const missing: SignedTx[] = [];
  let waiting: string | undefined;

  for (const tx of txs) {
    const found = await savedTxFate(rpc, chain, tx, depositAddress);
    if (found.fate === "wait") {
      waiting ??= found.reason;
      continue;
    }
    if (found.fate === "can_land") {
      missing.push(tx);
      continue;
    }
    if (found.fate === "lost") {
      return {
        status: "failed",
        message: `${chain.label} payout stopped: saved transfer ${tx.txid} can never land, because another transaction used nonce ${tx.nonce} of deposit address ${depositAddress}. Someone else may hold the deposit key. Check the address on a block explorer; whatever is left is still there.`,
        transfers: moved,
      };
    }
    const { receipt } = found;
    if (found.receipt.status === "0x0") {
      if (tx.kind === "platform_fee") {
        notes.push(`Platform transfer ${tx.txid} reverted: its gas was paid, but nothing moved. The platform's ${tx.amount} is still at deposit address ${depositAddress}; send it by hand.`);
        continue;
      }
      return {
        status: "failed",
        message: `${chain.label} payout stopped: transfer ${tx.txid} to ${tx.to} reverted: its gas was paid, but nothing moved. The funds are still at deposit address ${depositAddress}. Find out why the transfer was refused, then pay out by hand with the deposit key.`,
        transfers: moved,
      };
    }
    moved.push({ kind: tx.kind, to: tx.to, amount: proof(tx, receipt), txid: tx.txid });
  }

  for (const tx of missing) await broadcast(rpc, chain, tx);
  if (missing.length > 0) return { status: "pending", reason: "broadcast; waiting for the receipts" };
  if (waiting !== undefined) return { status: "pending", reason: waiting };

  for (const transfer of moved) {
    const planned = txs.find((tx) => tx.txid === transfer.txid);
    if (planned === undefined || BigInt(planned.amount) === transfer.amount) continue;
    if (transfer.kind === "platform_fee") {
      notes.push(`Platform transfer ${transfer.txid} delivered ${transfer.amount}, not the planned ${planned.amount}.`);
      continue;
    }
    return {
      status: "failed",
      message: `${chain.label} payout: transfer ${transfer.txid} to ${transfer.to} landed but delivered ${transfer.amount}, not the planned ${planned.amount} (a token fee or a refused transfer). Anything not delivered is still at deposit address ${depositAddress}. Check the token's transfer rules, then settle the difference by hand.`,
      transfers: moved,
    };
  }
  return { status: "paid", transfers: moved, ...(notes.length > 0 && { note: notes.join(" ") }) };
}

// ---------- Native coin ----------

/**
 * The F1 split of a native deposit. No platform transfer when the fee is 0
 * (a 0% rate, or money that already paid it), so only one transfer's gas.
 * undefined: too small to forward.
 */
export function decideTransferCount(input: { balance: bigint; gasPrice: bigint; feeRate: bigint; feeExempt?: bigint }) {
  const { balance, gasPrice, feeRate } = input;
  const feeExempt = input.feeExempt ?? 0n;
  // The fee does not depend on the network cost, so a zero-cost split shows it.
  const fee = splitPayout({ received: balance, networkCost: 0n, feeRate, feeExempt })?.platformFee ?? 0n;
  const transfers = fee === 0n ? 1n : 2n;
  const networkCost = gasPrice * TRANSFER_GAS * transfers;
  const split = splitPayout({ received: balance, networkCost, feeRate, feeExempt });
  return split === undefined ? undefined : { ...split, networkCost };
}

export async function estimateEvmNativeNetworkCost(deps: { chain: EvmChain; rpc: EvmRpc }): Promise<bigint | undefined> {
  const gasPrice = await gasPriceToPay(deps.rpc, deps.chain);
  return gasPrice === undefined ? undefined : gasPrice * TRANSFER_GAS * 2n;
}

/** The native side of ChainAdapter.payout (src/chains/adapter.ts). Never touches the database. */
export async function payOutEvmNative(
  request: PayoutRequest,
  deps: EvmPayoutDeps,
  ownAsset: AssetId,
): Promise<PayoutResult> {
  const { chain, rpc } = deps;
  const { depositAddress, destination, destinationKind } = request;

  if (request.checkpoint !== undefined) {
    const state = readState(request.checkpoint.state);
    if (state?.mode !== "native") return unreadable(chain, depositAddress);
    return await followDepositTransfers(request, deps, state.txs, (tx) => BigInt(tx.amount), []);
  }

  const prepared = await prepare(request, deps, ownAsset);
  if (!("wallet" in prepared)) return prepared;
  const { wallet, gasPrice, nonce } = prepared;

  const balance = await nativeBalance(rpc, depositAddress);
  if (balance === undefined) return { status: "pending", reason: `${chain.label} balance unavailable` };
  if (balance < request.minimumAmount || balance === 0n) return { status: "pending", reason: "the deposit holds less than the payout minimum" };

  // A plain 21,000-gas transfer can't pay a contract or a delegated wallet.
  const code = await codeAt(rpc, destination);
  if (code === undefined) return { status: "pending", reason: `${chain.label} code lookup unavailable` };
  if (code !== "0x") {
    return {
      status: "failed",
      message: `${chain.label} payout stopped: destination ${destination} is a contract or delegated wallet and can't receive a 21,000-gas transfer. Nothing was sent: all funds are still at deposit address ${depositAddress}. Ask the merchant for a normal wallet address, then set the invoice back to "confirmed".`,
      transfers: [],
    };
  }

  const split = decideTransferCount({ balance, gasPrice, feeRate: request.feeRate, feeExempt: request.feeExempt ?? 0n });
  if (split === undefined) return { status: "too_small", reason: `${chain.label} payout is too small after fees` };

  const txs = [
    await signTx(wallet, chain, { kind: destinationKind, recipient: destination, nonce, gasPrice, value: split.merchantAmount }),
  ];
  if (split.platformFee > 0n) {
    txs.push(
      await signTx(wallet, chain, { kind: "platform_fee", recipient: deps.platformAddress!, nonce: nonce + 1n, gasPrice, value: split.platformFee }),
    );
  }

  const state: PayoutState = { v: 1, mode: "native", txs };
  const saved = await request.saveCheckpoint({
    state: JSON.stringify(state),
    plan: { transfers: txs.map(asTransfer), platformFee: split.platformFee, networkCost: split.networkCost },
  });
  if (!saved) return { status: "pending", reason: "another run saved this payout first" };

  return await followDepositTransfers(request, deps, txs, (tx) => BigInt(tx.amount), []);
}

function unreadable(chain: EvmChain, depositAddress: string): PayoutResult {
  return {
    status: "pending",
    reason: `unreadable saved ${chain.label} payout`,
    review: `The saved ${chain.label} payout is unreadable. Funds may still be at deposit address ${depositAddress}; check a block explorer before sending anything.`,
  };
}

// ---------- Tokens ----------

/**
 * `wei` of native coin in token units at the current USD prices, rounded up
 * (in the platform's favour). undefined when a price is unavailable.
 */
async function nativeInTokenUnits(wei: bigint, deps: EvmTokenPayoutDeps): Promise<bigint | undefined> {
  if (wei === 0n) return 0n;
  const [nativeText, tokenText] = await Promise.all([
    deps.getPrice(deps.chain.nativeAsset, "usd"),
    deps.getPrice(deps.token.asset, "usd"),
  ]);
  const nativePrice = nativeText === undefined ? undefined : decimalStrToBigInt(nativeText, PRICE_DECIMALS);
  const tokenPrice = tokenText === undefined ? undefined : decimalStrToBigInt(tokenText, PRICE_DECIMALS);
  if (nativePrice === undefined || tokenPrice === undefined || nativePrice <= 0n || tokenPrice <= 0n) return undefined;
  return ceilDivide(
    wei * nativePrice * 10n ** BigInt(deps.token.decimals),
    tokenPrice * 10n ** BigInt(NATIVE_DECIMALS),
  );
}

/** What the gas wallet spends on a top-up of `value`: the value plus its own transfer's gas. */
const gasWalletSpend = (value: bigint, gasPrice: bigint) => (value === 0n ? 0n : value + gasPrice * TRANSFER_GAS);

/**
 * Payer-pays estimate for a token deposit, in token units: a top-up into an
 * empty deposit, two token transfers' gas, at today's gas price and prices.
 */
export async function estimateEvmTokenNetworkCost(deps: Omit<EvmTokenPayoutDeps, "platformAddress" | "gasWalletKey">): Promise<bigint | undefined> {
  const gasPrice = await gasPriceToPay(deps.rpc, deps.chain);
  if (gasPrice === undefined) return undefined;
  const topUp = gasPrice * TOKEN_TRANSFER_GAS_LIMIT * 2n;
  return await nativeInTokenUnits(gasWalletSpend(topUp, gasPrice), { ...deps, platformAddress: undefined, gasWalletKey: undefined });
}

function tokenProof(token: EvmToken, depositAddress: string) {
  return (tx: SignedTx, receipt: Receipt): bigint => {
    let delivered = 0n;
    for (const log of receipt.logs) {
      if (log.removed || log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (getAddress(log.address) !== getAddress(token.contract)) continue;
      if (getAddress(addressFromTopic(log.topics[1]!)) !== getAddress(depositAddress)) continue;
      if (getAddress(addressFromTopic(log.topics[2]!)) !== getAddress(tx.to)) continue;
      delivered += BigInt(log.data === "0x" ? 0 : log.data);
    }
    return delivered;
  };
}

const addressFromTopic = (topic: string) => "0x" + topic.slice(-40);

/** The token side of ChainAdapter.payout (src/chains/adapter.ts). Never touches the database. */
export async function payOutEvmToken(request: PayoutRequest, deps: EvmTokenPayoutDeps): Promise<PayoutResult> {
  const { chain, rpc, token } = deps;
  const { depositAddress, destination, destinationKind } = request;

  if (request.checkpoint !== undefined) {
    const state = readState(request.checkpoint.state);
    if (state?.mode !== "token") return unreadable(chain, depositAddress);
    const { platformFee, networkCost } = request.checkpoint.plan;
    return await followTokenPayout(request, deps, state, platformFee, networkCost);
  }

  if (deps.gasWalletKey === undefined) {
    return {
      status: "pending",
      reason: `${chain.label} gas wallet is not configured`,
      review: `The ${chain.label} gas wallet key is not configured, so this token payout can't pay its gas and waits. Nothing was sent: the tokens are still at deposit address ${depositAddress}. Set the gas wallet key in the server config.`,
    };
  }
  let gasWallet: Wallet;
  try {
    gasWallet = new Wallet(openSecret(chain.gasWalletPurpose, deps.gasWalletKey));
  } catch {
    return {
      status: "pending",
      reason: `${chain.label} gas wallet key can't be opened`,
      review: `The ${chain.label} gas wallet key can't be opened with the current data key, so this token payout waits. Nothing was sent: the tokens are still at deposit address ${depositAddress}.`,
    };
  }

  const prepared = await prepare(request, deps, token.asset);
  if (!("wallet" in prepared)) return prepared;
  const { wallet, gasPrice, nonce } = prepared;

  const [received, depositGas] = await Promise.all([
    tokenBalance(rpc, token.contract, depositAddress),
    nativeBalance(rpc, depositAddress),
  ]);
  if (received === undefined || depositGas === undefined) return { status: "pending", reason: `${chain.label} balances unavailable` };
  if (received < request.minimumAmount || received === 0n) return { status: "pending", reason: "the deposit holds less than the payout minimum" };

  // Two token transfers (merchant, platform), each up to its gas limit. Coin
  // already at the deposit (unused gas of an earlier payout) counts.
  const plan = async (transferCount: bigint) => {
    const needed = gasPrice * TOKEN_TRANSFER_GAS_LIMIT * transferCount;
    const topUp = needed > depositGas ? needed - depositGas : 0n;
    const reimbursement = await nativeInTokenUnits(gasWalletSpend(topUp, gasPrice), deps);
    if (reimbursement === undefined) return undefined;
    const split = splitPayout({ received, networkCost: reimbursement, feeRate: request.feeRate, feeExempt: request.feeExempt ?? 0n });
    return { topUp, reimbursement, split };
  };

  let planned = await plan(2n);
  if (planned === undefined) {
    return { status: "pending", reason: `no ${chain.label}/${token.asset} price to convert the gas cost` };
  }
  if (planned.split === undefined) return { status: "too_small", reason: `${token.asset} payout is too small after the fee and gas` };
  if (planned.split.platformFee + planned.reimbursement === 0n) {
    // Nothing for the platform: one transfer, so less gas is needed.
    planned = (await plan(1n))!;
    if (planned.split === undefined) return { status: "too_small", reason: `${token.asset} payout is too small after the fee and gas` };
  }
  const { topUp, reimbursement, split } = planned as typeof planned & { split: NonNullable<typeof planned.split> };
  const platformAmount = split.platformFee + reimbursement;

  let topUpTx: SignedTx | undefined;
  if (topUp > 0n) {
    const signed = await signTopUp(deps, gasWallet, depositAddress, topUp, gasPrice);
    if ("status" in signed) return signed;
    topUpTx = signed;
  }

  const txs = [
    await signTx(wallet, chain, { kind: destinationKind, recipient: destination, nonce, gasPrice, token, tokenAmount: split.merchantAmount }),
  ];
  if (platformAmount > 0n) {
    txs.push(
      await signTx(wallet, chain, { kind: "platform_fee", recipient: deps.platformAddress!, nonce: nonce + 1n, gasPrice, token, tokenAmount: platformAmount }),
    );
  }

  const state: TokenState = {
    v: 1,
    mode: "token",
    phase: topUpTx === undefined ? "transfers" : "top_up",
    gasPrice: gasPrice.toString(),
    gasWallet: getAddress(gasWallet.address),
    ...(topUpTx !== undefined && { topUp: topUpTx }),
    txs,
  };
  const saved = await request.saveCheckpoint(tokenCheckpoint(state, split.platformFee, reimbursement));
  if (!saved) return { status: "pending", reason: "another run saved this payout first" };

  return await followTokenPayout(request, deps, state, split.platformFee, reimbursement);
}

function tokenCheckpoint(state: TokenState, platformFee: bigint, reimbursement: bigint) {
  return {
    state: JSON.stringify(state),
    plan: {
      transfers: [...(state.topUp ? [state.topUp] : []), ...state.txs].map(asTransfer),
      platformFee,
      // In token units: what the gas wallet spent, converted. The gas_top_up
      // transfer itself is in native units.
      networkCost: reimbursement,
    },
  };
}

/** Signs the gas wallet's top-up, after checking the gas wallet can pay it. */
async function signTopUp(
  deps: EvmTokenPayoutDeps,
  gasWallet: Wallet,
  depositAddress: string,
  value: bigint,
  gasPrice: bigint,
): Promise<SignedTx | PayoutResult> {
  const { chain, rpc } = deps;
  const [balance, nonce] = await Promise.all([
    nativeBalance(rpc, gasWallet.address),
    // Counts the gas wallet's top-ups for other payouts still in flight.
    nonceOf(rpc, gasWallet.address, "pending"),
  ]);
  if (balance === undefined || nonce === undefined) return { status: "pending", reason: `${chain.label} gas wallet lookup failed` };
  const spend = gasWalletSpend(value, gasPrice);
  if (balance < spend) {
    return {
      status: "pending",
      reason: `${chain.label} gas wallet is short of funds`,
      review: `The ${chain.label} gas wallet ${gasWallet.address} holds ${balance} and this token payout's gas top-up needs ${spend} (smallest units). Fund the gas wallet; the payout continues by itself. The tokens are still at deposit address ${depositAddress}.`,
    };
  }
  return await signTx(gasWallet, chain, { kind: "gas_top_up", recipient: depositAddress, nonce, gasPrice, value });
}

async function followTokenPayout(
  request: PayoutRequest,
  deps: EvmTokenPayoutDeps,
  state: TokenState,
  platformFee: bigint,
  reimbursement: bigint,
): Promise<PayoutResult> {
  const { chain, rpc, token } = deps;
  const { depositAddress } = request;
  let current = state;

  // A false save means another run owns the payout: send nothing.
  const advance = async (next: TokenState): Promise<boolean> => {
    const ok = await request.saveCheckpoint(tokenCheckpoint(next, platformFee, reimbursement));
    if (ok) current = next;
    return ok;
  };

  if (current.phase === "top_up") {
    const topUp = current.topUp;
    if (topUp === undefined) return unreadable(chain, depositAddress);
    const found = await savedTxFate(rpc, chain, topUp, current.gasWallet);
    if (found.fate === "wait") return { status: "pending", reason: found.reason };
    if (found.fate === "can_land") {
      await broadcast(rpc, chain, topUp);
      return { status: "pending", reason: "gas top-up broadcast; waiting for its receipt" };
    }

    if (found.fate === "lost") {
      // Its nonce went to another gas wallet transaction: this top-up can
      // never land. Same value and gas price, next free nonce, saved first.
      if (deps.gasWalletKey === undefined) {
        return {
          status: "pending",
          reason: `${chain.label} gas wallet is not configured`,
          review: `Gas top-up ${topUp.txid} can never land and the ${chain.label} gas wallet key is not configured to send another. The tokens are still at deposit address ${depositAddress}.`,
        };
      }
      const gasWallet = new Wallet(openSecret(chain.gasWalletPurpose, deps.gasWalletKey));
      if (getAddress(gasWallet.address) !== getAddress(current.gasWallet)) {
        return {
          status: "pending",
          reason: "the gas wallet changed",
          review: `Gas top-up ${topUp.txid} can never land, and the configured ${chain.label} gas wallet is not the one that signed it. The tokens are still at deposit address ${depositAddress}; review before retrying.`,
        };
      }
      const rebuilt = await signTopUp(deps, gasWallet, depositAddress, BigInt(topUp.amount), BigInt(current.gasPrice));
      if ("status" in rebuilt) return rebuilt;
      if (!(await advance({ ...current, topUp: rebuilt }))) return { status: "pending", reason: "another run saved this payout first" };
      await broadcast(rpc, chain, rebuilt);
      return { status: "pending", reason: "gas top-up rebuilt and broadcast" };
    }

    if (found.receipt.status === "0x0") {
      // A value transfer to an address with no code can't revert.
      return {
        status: "failed",
        message: `${chain.label} payout stopped: gas top-up ${topUp.txid} reverted. No tokens moved: they are still at deposit address ${depositAddress}. Check the deposit address for code, then pay out by hand.`,
        transfers: [],
      };
    }
    if (!(await advance({ ...current, phase: "transfers" }))) return { status: "pending", reason: "another run saved this payout first" };
  }

  const topUpMoved = current.topUp ? [asTransfer(current.topUp)] : [];
  return await followDepositTransfers(request, deps, current.txs, tokenProof(token, depositAddress), topUpMoved);
}
