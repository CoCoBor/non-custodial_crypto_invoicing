import {
  address as toSolAddress,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  blockhash as toBlockhash,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  getTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { z } from "zod";
import { env } from "../config/env.js";
import { Invoice } from "../database/invoices.model.js";
import { User } from "../database/users.model.js";
import { ceilDivide } from "../money/format.js";
import { parseFeeRate, splitPayout } from "../money/payout-split.js";
import { openSecret, type SealedSecret } from "../security/secret-envelope.js";
import {
  isCryptoId,
  prepareSwap,
  swapFieldsToSave,
  type PreparedSwap,
} from "../swap/near.js";
import cryptos from "../storage/cryptos.json" with { type: "json" };

// Solana: payment lookup and payout for SOL, USDT and USDC.
// Network calls go through post() (JSON-RPC to NOWNodes). @solana/kit only
// builds and signs transactions; it never talks to the network here.

const SOL_RPC_URL = "https://sol.nownodes.io";

// Size of an SPL token account in bytes. Its rent deposit is what it costs
// to create a USDT account for someone. Ask the chain (getSolRentExemption):
// the price has changed before (1,488,440 lamports on 2026-11-09).
const TOKEN_ACCOUNT_SIZE = 165;

// Solana's fee = 5,000 lamports per signature + priority fee.
// Priority fee = price (micro-lamports per compute unit) x the compute unit
// LIMIT we ask for, rounded up. The limit is charged even if the tx uses
// less, so the limits below are measured, plus a safety margin.
const LAMPORTS_PER_SIGNATURE = 5_000n;
const MICROLAMPORTS_PER_LAMPORT = 1_000_000n;
// 2 compute-budget + up to 2 SOL transfers. Mainnet simulation on
// 2026-11-09 used 600.
const SOL_PAYOUT_COMPUTE_UNITS = 1_500;
// 2 compute-budget + 2 create-if-missing + 2 token transfers + 1 close.
// Mainnet simulation on 2026-11-09: 30,664 when both receivers need a new
// token account (worst case), 15,502 when both already have one.
const TOKEN_PAYOUT_COMPUTE_UNITS = 100_000;

// Priority fee price, micro-lamports per compute unit. Most blocks accept 0,
// so the floor is what we pay on a normal day; the estimate only wins when
// the network is busy. The cap stops a broken estimate from overpaying.
const MIN_PRIORITY_FEE = 50_000n;
const MAX_PRIORITY_FEE = 2_000_000n;

// Merchant fee rates have 8 decimals: "0.005" = 0.5% = 500,000 / 10^8.
const FEE_RATE_DECIMALS = 8;
const FEE_RATE_SCALE = 10n ** BigInt(FEE_RATE_DECIMALS);

const STUCK_TX_REVIEW_MS = 24 * 60 * 60 * 1000;

// Base58 text (no 0, O, I, l). 32-byte addresses/blockhashes are 32–44 chars,
// 64-byte signatures are 64–88 chars.
const base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const base58Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);

// Solana sends u64 values (lamports, slots, heights) as JSON numbers.
// Above 2^53 a JS number silently loses digits; zod 4's int() rejects those.
const u64Number = z.number().int().nonnegative();

// Token amounts come as integer strings in the token's smallest unit
// (USDT has 6 decimals: "1000000" = 1 USDT).
const u64String = z.string().regex(/^(?:0|[1-9][0-9]*)$/);

// confirmed = voted on by most validators, very unlikely to roll back.
// finalized = cannot roll back. Decide money with finalized.
type Commitment = "confirmed" | "finalized";

// ---------- Which coins live on Solana ----------

const SOL_CRYPTOS = ["sol", "usdtsol", "usdcsol"] as const;
type SolCrypto = (typeof SOL_CRYPTOS)[number];

type TokenAsset = {
  kind: "token";
  name: string;
  mint: Address;
  decimals: number;
};
type SolAsset = { kind: "sol"; name: "SOL" } | TokenAsset;

function isSolCrypto(value: string): value is SolCrypto {
  return (SOL_CRYPTOS as readonly string[]).includes(value);
}

function getSolAsset(crypto: SolCrypto): SolAsset {
  if (crypto === "sol") return { kind: "sol", name: "SOL" };

  // The mint is the token's ID. Anyone can make a token called "USDT"; only
  // this mint is the real one, so it comes from our config, never a payer.
  const entry = cryptos[crypto];
  return {
    kind: "token",
    name: entry.symbol.toUpperCase(),
    mint: toSolAddress(entry.mint_address),
    decimals: entry.decimal,
  };
}

export function isValidSolAddress(value: string): boolean {
  return isAddress(value);
}

// ---------- JSON-RPC ----------

async function post(method: string, params: unknown[]): Promise<unknown> {
  try {
    const res = await fetch(SOL_RPC_URL, {
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
      console.warn("SOL RPC HTTP failed:", method, res.status);
      return undefined;
    }

    const body: unknown = await res.json();

    const rpcError = z
      .object({
        error: z.object({ code: z.number(), message: z.string() }),
      })
      .safeParse(body);

    if (rpcError.success) {
      // Never log params: for sendTransaction they hold the signed tx.
      console.warn(
        "SOL RPC error:",
        method,
        rpcError.data.error.code,
        rpcError.data.error.message,
      );
      return undefined;
    }

    const rpcResult = z.object({ result: z.unknown() }).safeParse(body);
    return rpcResult.success ? rpcResult.data.result : undefined;
  } catch (error) {
    console.warn(
      "SOL RPC request failed:",
      method,
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}

// Native SOL balance in lamports (1 SOL = 1,000,000,000 lamports).
async function getSolBalance(address: string, commitment: Commitment) {
  const parsed = z
    .object({ value: u64Number })
    .safeParse(await post("getBalance", [address, { commitment }]));

  return parsed.success ? BigInt(parsed.data.value) : undefined;
}

// undefined = lookup failed (retry). null = no account at this address
// (a wallet that never held SOL looks like this, and is still a valid wallet).
// owner = the program that controls the account: System Program for a normal
// wallet, Token Program for a token account. Like eth_getCode, it tells you
// what kind of address you are about to pay.
async function getSolAccountInfo(address: string, commitment: Commitment) {
  const parsed = z
    .object({
      value: z
        .object({
          owner: base58Address,
          lamports: u64Number,
          executable: z.boolean(),
        })
        .nullable(),
    })
    .safeParse(
      await post("getAccountInfo", [
        address,
        // Only the header is needed, so ask for 0 bytes of account data.
        { commitment, encoding: "base64", dataSlice: { offset: 0, length: 0 } },
      ]),
    );

  if (!parsed.success) return undefined;
  if (parsed.data.value === null) return null;

  return {
    owner: parsed.data.value.owner,
    lamports: BigInt(parsed.data.value.lamports),
    executable: parsed.data.value.executable,
  };
}

// All token accounts `owner` holds for one token (`mint`). Usually 0 or 1
// (the associated token account), but anyone can create extra ones, so this
// returns a list. "spl-token" = the original Token Program, which USDT uses;
// a Token-2022 token fails the parse on purpose.
async function getSolTokenAccounts(
  owner: string,
  mint: string,
  commitment: Commitment,
) {
  const parsed = z
    .object({
      value: z.array(
        z.object({
          pubkey: base58Address,
          account: z.object({
            data: z.object({
              program: z.literal("spl-token"),
              parsed: z.object({
                type: z.literal("account"),
                info: z.object({
                  mint: base58Address,
                  owner: base58Address,
                  state: z.enum(["uninitialized", "initialized", "frozen"]),
                  tokenAmount: z.object({
                    amount: u64String,
                    decimals: z.number().int().nonnegative(),
                  }),
                }),
              }),
            }),
          }),
        }),
      ),
    })
    .safeParse(
      await post("getTokenAccountsByOwner", [
        owner,
        { mint },
        { commitment, encoding: "jsonParsed" },
      ]),
    );

  if (!parsed.success) return undefined;

  const accounts = [];
  for (const item of parsed.data.value) {
    const info = item.account.data.parsed.info;
    // The RPC already filtered by owner and mint. Check again, so a wrong
    // answer can never be counted as a payment.
    if (info.owner !== owner || info.mint !== mint) return undefined;

    accounts.push({
      address: item.pubkey,
      amount: BigInt(info.tokenAmount.amount),
      decimals: info.tokenAmount.decimals,
      state: info.state,
    });
  }

  return accounts;
}

// Every transaction must include a recent blockhash. It can only land while
// the block height is <= lastValidBlockHeight (about 150 blocks, ~60–90 s).
// After that the tx is dead and can never land.
async function getSolLatestBlockhash(commitment: Commitment) {
  const parsed = z
    .object({
      value: z.object({
        blockhash: base58Address,
        lastValidBlockHeight: u64Number,
      }),
    })
    .safeParse(await post("getLatestBlockhash", [{ commitment }]));

  return parsed.success ? parsed.data.value : undefined;
}

// Compare with lastValidBlockHeight to know whether a tx has expired.
async function getSolBlockHeight(commitment: Commitment) {
  const parsed = u64Number.safeParse(
    await post("getBlockHeight", [{ commitment }]),
  );

  return parsed.success ? BigInt(parsed.data) : undefined;
}

// Solana's version of a receipt lookup.
// undefined = lookup failed (retry).
// null = not found: not landed yet, or expired and never will.
// err null = succeeded. err set = failed on chain: the fee was paid,
// nothing else happened (like an ETH receipt with status 0x0).
async function getSolSignatureStatus(signature: string) {
  const parsed = z
    .object({
      value: z.tuple([
        z
          .object({
            slot: u64Number,
            err: z.union([
              z.null(),
              z.string(),
              z.record(z.string(), z.unknown()),
            ]),
            confirmationStatus: z
              .enum(["processed", "confirmed", "finalized"])
              .nullable(),
          })
          .nullable(),
      ]),
    })
    .safeParse(
      await post("getSignatureStatuses", [
        [signature],
        // Also look past the recent cache, so an old tx is found, not "null".
        { searchTransactionHistory: true },
      ]),
    );

  if (!parsed.success) return undefined;

  const status = parsed.data.value[0];
  if (status === null) return null;

  return {
    slot: status.slot,
    err: status.err,
    confirmationStatus: status.confirmationStatus,
  };
}

// Sends a signed transaction (base64). Returns its signature, which is also
// its tx id. Preflight (simulation) stays on, so a tx that would fail is
// rejected before it costs a fee. Sending the same signed tx again is safe:
// it can land at most once.
async function sendSolTransaction(signedTx: string) {
  const parsed = base58Signature.safeParse(
    await post("sendTransaction", [
      signedTx,
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]),
  );

  return parsed.success ? parsed.data : undefined;
}

// Lamports an account of `space` bytes must hold to exist.
// For a token account (165 bytes) this is the cost of creating it.
// For a plain wallet (0 bytes) it is the smallest balance it can have,
// other than exactly 0.
async function getSolRentExemption(space: number) {
  const parsed = u64Number.safeParse(
    await post("getMinimumBalanceForRentExemption", [space]),
  );

  return parsed.success ? BigInt(parsed.data) : undefined;
}

// Recent priority fee prices (micro-lamports per compute unit), one per
// block: the lowest price that landed in that block. Takes the 75th
// percentile, then applies the floor and the cap.
async function getSolPriorityFee() {
  const parsed = z
    .array(z.object({ slot: u64Number, prioritizationFee: u64Number }))
    .safeParse(await post("getRecentPrioritizationFees", []));

  if (!parsed.success) return undefined;

  const prices = parsed.data
    .map((block) => BigInt(block.prioritizationFee))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const p75 =
    prices.length > 0 ? prices[Math.floor((prices.length - 1) * 0.75)] : 0n;

  if (p75 < MIN_PRIORITY_FEE) return MIN_PRIORITY_FEE;
  if (p75 > MAX_PRIORITY_FEE) return MAX_PRIORITY_FEE;
  return p75;
}

// ---------- Accounts ----------

// A payout address must be a normal wallet: no account yet, or an account
// owned by the System Program. A token account or a program's account would
// take the money, and nobody could move it out.
async function getSolWallet(owner: string) {
  const info = await getSolAccountInfo(owner, "confirmed");
  if (info === undefined) return undefined;
  if (info === null) return { lamports: 0n };
  if (info.owner !== SYSTEM_PROGRAM_ADDRESS || info.executable) {
    return "not-a-wallet" as const;
  }
  return { lamports: info.lamports };
}

// A wallet holds a token in its associated token account (ATA): an address
// computed from (wallet, token program, mint). Wallets and exchanges always
// send to it, so it is the only token account this code counts or pays.
async function findAta(owner: string, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner: toSolAddress(owner),
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

// The token balance in `owner`'s ATA. No ATA = 0.
async function getAtaBalance(
  owner: string,
  asset: TokenAsset,
  commitment: Commitment,
) {
  const ata = await findAta(owner, asset.mint);
  const accounts = await getSolTokenAccounts(owner, asset.mint, commitment);
  if (accounts === undefined) return undefined;

  const account = accounts.find((item) => item.address === ata);
  if (!account) return { ata, amount: 0n, frozen: false };

  if (account.decimals !== asset.decimals) {
    console.warn(
      `${asset.name} account has unexpected decimals:`,
      ata,
      account.decimals,
    );
    return undefined;
  }

  return { ata, amount: account.amount, frozen: account.state === "frozen" };
}

// Can `owner` receive this token? exists=false: the payout creates the ATA
// (the gas wallet pays its rent).
type TokenDestination = { ata: Address; exists: boolean } | { problem: string };

async function checkTokenDestination(
  owner: string,
  asset: TokenAsset,
): Promise<TokenDestination | undefined> {
  const ata = await findAta(owner, asset.mint);
  const accounts = await getSolTokenAccounts(owner, asset.mint, "confirmed");
  if (accounts === undefined) return undefined;

  const account = accounts.find((item) => item.address === ata);
  if (account) {
    if (account.state !== "initialized") {
      return { problem: `${ata} is ${account.state} (USDT/USDC issuers can freeze accounts)` };
    }
    if (account.decimals !== asset.decimals) {
      return { problem: `${ata} reports ${account.decimals} decimals` };
    }
    return { ata, exists: true };
  }

  // Not in this wallet's list. Make sure nothing else sits at that address.
  const info = await getSolAccountInfo(ata, "confirmed");
  if (info === undefined) return undefined;
  if (info !== null) {
    return { problem: `an account already exists at ${ata}, but it is not this wallet's ${asset.name} account` };
  }
  return { ata, exists: false };
}

// The key text is base58 of 64 bytes (see crypto/sol.ts). Kit checks that
// the public half matches the private half.
async function loadSolSigner(secret: string): Promise<KeyPairSigner> {
  return await createKeyPairSignerFromBytes(getBase58Encoder().encode(secret));
}

// ---------- Payment lookup ----------

// For the invoice watcher. receivedAmount = seen at "confirmed" (show as
// confirming), confirmedAmount = "finalized" (safe to pay out).
// Balance-based: a deposit address only ever receives, until the payout
// empties it. Note: a payment to a brand-new SOL address must be at least
// the empty-wallet rent minimum (650,240 lamports on 2026-11-09), or the
// payer's own tx fails.
export async function getSolanaPaymentTotals(
  crypto: string,
  depositAddress: string,
): Promise<{ receivedAmount: bigint; confirmedAmount: bigint } | undefined> {
  if (!isSolCrypto(crypto) || !isAddress(depositAddress)) return undefined;
  const asset = getSolAsset(crypto);

  let seen: bigint | undefined;
  let final: bigint | undefined;

  if (asset.kind === "sol") {
    seen = await getSolBalance(depositAddress, "confirmed");
    final = await getSolBalance(depositAddress, "finalized");
  } else {
    seen = (await getAtaBalance(depositAddress, asset, "confirmed"))?.amount;
    final = (await getAtaBalance(depositAddress, asset, "finalized"))?.amount;
  }

  if (seen === undefined || final === undefined) return undefined;

  // Two calls can hit two RPC nodes; never show less than is final.
  return {
    receivedAmount: seen > final ? seen : final,
    confirmedAmount: final,
  };
}

// ---------- Payout math (pure) ----------

function getSolNetworkFee(
  signatures: bigint,
  computeUnitLimit: number,
  priorityFee: bigint,
): bigint {
  return (
    LAMPORTS_PER_SIGNATURE * signatures +
    ceilDivide(BigInt(computeUnitLimit) * priorityFee, MICROLAMPORTS_PER_LAMPORT)
  );
}

// SOL payout: the deposit pays its own fee and ends at exactly 0.
// Solana rule: after a tx, every account must hold 0 or at least
// rentMinimum. So a fee too small to open an empty platform wallet goes to
// the merchant (like BTC dust), and a merchant amount too small to open the
// merchant's wallet waits.
function planSolPayout(input: {
  total: bigint;
  priorityFee: bigint;
  feeRate: bigint;
  platformLamports: bigint;
  merchantLamports: bigint;
  rentMinimum: bigint;
}) {
  const { total, priorityFee, feeRate, platformLamports, merchantLamports, rentMinimum } = input;
  if (total < 0n || feeRate < 0n || feeRate >= FEE_RATE_SCALE) {
    throw new RangeError("invalid SOL payout input");
  }

  const networkFee = getSolNetworkFee(1n, SOL_PAYOUT_COMPUTE_UNITS, priorityFee);
  const split = splitPayout({ received: total, networkCost: networkFee, feeRate });
  if (split === undefined) return undefined;

  let { platformFee, merchantAmount } = split;
  if (platformFee > 0n && platformLamports + platformFee < rentMinimum) {
    merchantAmount += platformFee;
    platformFee = 0n;
  }

  if (merchantAmount === 0n || merchantLamports + merchantAmount < rentMinimum) {
    return undefined;
  }

  return { networkFee, platformFee, merchantAmount };
}

// Token payout: the gas wallet pays the fee in SOL, so the merchant gets
// everything except the platform fee. No dust rule for tokens.
function planTokenPayout(total: bigint, feeRate: bigint) {
  if (total < 0n || feeRate < 0n || feeRate >= FEE_RATE_SCALE) {
    throw new RangeError("invalid token payout input");
  }

  const split = splitPayout({ received: total, networkCost: 0n, feeRate });
  if (split === undefined) return undefined;

  return split;
}

// ---------- Building and signing ----------

type Lifetime = { blockhash: string; lastValidBlockHeight: number };

// The signature is known before sending, so it can be saved first.
async function signSolanaTx(
  feePayer: KeyPairSigner,
  instructions: Instruction[],
  lifetime: Lifetime,
) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: toBlockhash(lifetime.blockhash),
          lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  // Signers come from the fee payer and from the instructions' accounts.
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithinSizeLimit(signed);

  return {
    signature: getSignatureFromTransaction(signed),
    wire: getBase64EncodedWireTransaction(signed),
  };
}

function priorityInstructions(computeUnits: number, priorityFee: bigint) {
  return [
    getSetComputeUnitLimitInstruction({ units: computeUnits }),
    getSetComputeUnitPriceInstruction({ microLamports: priorityFee }),
  ];
}

async function signSolPayout(input: {
  deposit: KeyPairSigner;
  merchant: Address;
  platform: Address;
  platformFee: bigint;
  merchantAmount: bigint;
  priorityFee: bigint;
  lifetime: Lifetime;
}) {
  const instructions: Instruction[] = priorityInstructions(
    SOL_PAYOUT_COMPUTE_UNITS,
    input.priorityFee,
  );

  if (input.platformFee > 0n) {
    instructions.push(
      getTransferSolInstruction({
        source: input.deposit,
        destination: input.platform,
        amount: input.platformFee,
      }),
    );
  }
  instructions.push(
    getTransferSolInstruction({
      source: input.deposit,
      destination: input.merchant,
      amount: input.merchantAmount,
    }),
  );

  return await signSolanaTx(input.deposit, instructions, input.lifetime);
}

// One tx, all-or-nothing: create the receivers' token accounts if missing,
// move the tokens, then (normal payouts) close the empty deposit token
// account so its rent goes back to the gas wallet (that refund covers this
// tx's fee many times).
async function signTokenPayout(input: {
  gas: KeyPairSigner;
  deposit: KeyPairSigner;
  asset: TokenAsset;
  depositAta: Address;
  merchant: Address;
  merchantAta: Address;
  platform: Address;
  platformAta: Address | undefined;
  platformFee: bigint;
  merchantAmount: bigint;
  priorityFee: bigint;
  lifetime: Lifetime;
  closeDepositAccount: boolean;
}) {
  const { gas, deposit, asset } = input;
  const instructions: Instruction[] = priorityInstructions(
    TOKEN_PAYOUT_COMPUTE_UNITS,
    input.priorityFee,
  );

  if (input.platformFee > 0n) {
    if (input.platformAta === undefined) {
      throw new Error("platform token account is missing from the plan");
    }
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: gas,
        ata: input.platformAta,
        owner: input.platform,
        mint: asset.mint,
      }),
      getTransferCheckedInstruction({
        source: input.depositAta,
        mint: asset.mint,
        destination: input.platformAta,
        authority: deposit,
        amount: input.platformFee,
        decimals: asset.decimals,
      }),
    );
  }

  instructions.push(
    getCreateAssociatedTokenIdempotentInstruction({
      payer: gas,
      ata: input.merchantAta,
      owner: input.merchant,
      mint: asset.mint,
    }),
    getTransferCheckedInstruction({
      source: input.depositAta,
      mint: asset.mint,
      destination: input.merchantAta,
      authority: deposit,
      amount: input.merchantAmount,
      decimals: asset.decimals,
    }),
  );

  if (input.closeDepositAccount) {
    instructions.push(
      getCloseAccountInstruction({
        account: input.depositAta,
        destination: gas.address,
        owner: deposit,
      }),
    );
  }

  return await signSolanaTx(gas, instructions, input.lifetime);
}

// ---------- Prepare one payout ----------

type PreparedPayout =
  | { kind: "wait" }
  | { kind: "stop"; reason: string }
  | {
      kind: "ready";
      signature: string;
      wire: string;
      lastValidBlockHeight: number;
      // What the receiver gets: the merchant, or NEAR for a swap.
      merchantAmount: bigint;
      // In the coin paid out. Token payouts: 0 (the gas wallet pays in SOL).
      networkFee: bigint;
      platformFee: bigint;
      swap: PreparedSwap | undefined;
    };

// The payout if `address` receives it.
type ReceiverPlan =
  | {
      kind: "ok";
      networkFee: bigint;
      platformFee: bigint;
      merchantAmount: bigint;
      receiverAta?: Address;
      receiverExists: boolean;
    }
  | { kind: "wait"; why: string }
  | { kind: "problem"; text: string };

function notAWallet(address: string) {
  return `${address} is not a normal Solana wallet (a program owns it; a common mistake is giving a token account instead of the wallet address), so funds sent there could be locked`;
}

// Everything up to a signed tx. Nothing is sent and nothing is saved.
// wait = temporary problem (retry next round), stop = permanent problem
// (needs a person). Problems with our own config throw.
async function prepareSolanaPayout(input: {
  invoiceId: string;
  crypto: SolCrypto;
  asset: SolAsset;
  depositAddress: string;
  merchantAddress: string;
  platformAddress: string;
  userId: string;
  feePaidByPayer: boolean;
  toCrypto: string;
  sealedDepositKey: SealedSecret | null | undefined;
  // The deposit must hold at least this much (the invoice amount).
  minimumTotal: bigint;
}): Promise<PreparedPayout> {
  const { asset, depositAddress, merchantAddress, platformAddress } = input;
  const fundsAt = `All funds are still at deposit address ${depositAddress}.`;

  function wait(why: string): PreparedPayout {
    console.warn(`${asset.name} payout waiting (${why}); will retry:`, input.invoiceId);
    return { kind: "wait" };
  }
  function stop(reason: string): PreparedPayout {
    return { kind: "stop", reason: `Payout stopped: ${reason}` };
  }

  if (input.feePaidByPayer) {
    return stop(`payer-paid fees are not supported for ${asset.name} yet. ${fundsAt} Pay out manually.`);
  }

  const toCrypto = input.toCrypto;
  if (!isCryptoId(toCrypto)) {
    return stop(`payout asset "${toCrypto}" is unknown. ${fundsAt} Fix to_crypto, then pay out manually.`);
  }
  // Paid in one coin but wanted in another: swap through NEAR.
  const swapTo = toCrypto === input.crypto ? undefined : toCrypto;

  if (!isAddress(depositAddress)) {
    return stop(`deposit address "${depositAddress}" is not a valid Solana address. Check how this invoice was created before moving any funds.`);
  }

  // With a swap, the merchant address is on the other chain; NEAR checks
  // it when quoting.
  if (swapTo === undefined) {
    if (!isAddress(merchantAddress)) {
      return stop(`merchant payout address "${merchantAddress}" is not a valid Solana address. ${fundsAt} Fix the merchant's Solana address, then pay out manually.`);
    }
    if (merchantAddress === depositAddress) {
      return stop(`merchant payout address is the deposit address itself. ${fundsAt} Fix the merchant's Solana address, then pay out manually.`);
    }
  }

  const user = await User.findOne({ user_id: input.userId })
    .select("merchant_fee")
    .exec();
  if (!user) {
    return stop(`merchant account ${input.userId} was not found. ${fundsAt} Check whether the merchant was deleted, then pay out manually.`);
  }

  const feeRate = parseFeeRate(user.merchant_fee);
  if (feeRate === undefined) {
    return stop(`merchant fee rate "${user.merchant_fee}" is not a valid rate below 100%. ${fundsAt} Fix merchant_fee (e.g. "0.005" = 0.5%), then pay out manually.`);
  }

  if (!input.sealedDepositKey) {
    return stop(`the deposit private key is missing from the database. ${fundsAt} Restore the key from backup; without it the funds cannot be moved.`);
  }

  let deposit: KeyPairSigner;
  try {
    deposit = await loadSolSigner(
      openSecret("solana-deposit-key", input.sealedDepositKey),
    );
  } catch (error) {
    return stop(`the deposit key could not be opened (${error instanceof Error ? error.message : "unknown error"}). Nothing was sent. ${fundsAt}`);
  }
  if (deposit.address !== depositAddress) {
    return stop(`the saved key does not control deposit address ${depositAddress}. Nothing was sent. Find the right key before moving the funds.`);
  }

  const platformWallet = await getSolWallet(platformAddress);
  if (platformWallet === undefined) return wait("platform account lookup failed");
  if (platformWallet === "not-a-wallet") {
    throw new Error("PLATFORM_SOL_ADDRESS is not a normal Solana wallet");
  }

  const rentMinimum = await getSolRentExemption(0);
  if (rentMinimum === undefined) return wait("rent lookup failed");

  const priorityFee = await getSolPriorityFee();
  if (priorityFee === undefined) return wait("priority fee lookup failed");

  // Who receives the payout: the merchant, or NEAR's deposit address for a
  // swap. `planFor` says what paying a given address would look like.
  const pickReceiver = async (
    planFor: (address: string) => Promise<ReceiverPlan>,
  ) => {
    let receiver = merchantAddress;
    let swap: PreparedSwap | undefined;

    if (swapTo !== undefined) {
      swap = await prepareSwap(
        {
          crypto: input.crypto,
          isValidAddress: isAddress,
          amountArrivingAt: async (address) => {
            const plan = await planFor(address);
            return plan.kind === "ok" ? plan.merchantAmount : undefined;
          },
          refundAddress: depositAddress,
          platformAddress,
        },
        swapTo,
        merchantAddress,
      );
      if (swap === undefined) return wait("swap quote not ready");
      receiver = swap.depositAddress;
    }

    const plan = await planFor(receiver);
    if (plan.kind === "wait") return wait(plan.why);
    if (plan.kind === "problem") {
      return swap
        ? wait(`NEAR's deposit address can't receive: ${plan.text}`)
        : stop(`the merchant can't receive ${asset.name}: ${plan.text}. ${fundsAt} Ask the merchant for another wallet address, then pay out manually.`);
    }
    // NEAR refunds everything if less than the quoted amount arrives.
    if (swap !== undefined && plan.merchantAmount !== swap.amount) {
      return wait("the payout no longer matches the swap quote");
    }

    return { kind: "picked" as const, receiver, swap, plan };
  };

  // ----- SOL -----
  if (asset.kind === "sol") {
    const total = await getSolBalance(depositAddress, "finalized");
    const seen = await getSolBalance(depositAddress, "confirmed");
    if (total === undefined || seen === undefined) {
      return wait("deposit balance lookup failed");
    }
    // The tx must empty the deposit exactly. A payment still arriving
    // would leave a remainder and could make the whole tx fail.
    if (seen !== total) return wait("a payment to the deposit is not final yet");
    if (total < input.minimumTotal) return wait("the deposit holds less than expected");

    const picked = await pickReceiver(async (address): Promise<ReceiverPlan> => {
      const wallet = await getSolWallet(address);
      if (wallet === undefined) return { kind: "wait", why: "receiver account lookup failed" };
      if (wallet === "not-a-wallet") return { kind: "problem", text: notAWallet(address) };

      const plan = planSolPayout({
        total,
        priorityFee,
        feeRate,
        platformLamports: platformWallet.lamports,
        merchantLamports: wallet.lamports,
        rentMinimum,
      });
      if (plan === undefined) {
        return { kind: "wait", why: "too small after the fee, or too small to open an empty receiving wallet" };
      }
      return { kind: "ok", ...plan, receiverExists: true };
    });
    if (picked.kind !== "picked") return picked;

    const lifetime = await getSolLatestBlockhash("confirmed");
    if (lifetime === undefined) return wait("blockhash lookup failed");

    try {
      const signed = await signSolPayout({
        deposit,
        merchant: toSolAddress(picked.receiver),
        platform: toSolAddress(platformAddress),
        platformFee: picked.plan.platformFee,
        merchantAmount: picked.plan.merchantAmount,
        priorityFee,
        lifetime,
      });
      return {
        kind: "ready",
        ...signed,
        lastValidBlockHeight: lifetime.lastValidBlockHeight,
        networkFee: picked.plan.networkFee,
        platformFee: picked.plan.platformFee,
        merchantAmount: picked.plan.merchantAmount,
        swap: picked.swap,
      };
    } catch (error) {
      return stop(`signing failed (${error instanceof Error ? error.message : "unknown error"}). Nothing was sent. ${fundsAt} Investigate before retrying.`);
    }
  }

  // ----- USDT / USDC -----
  if (env.solGasWalletKey === undefined) {
    return wait("SOL_GAS_WALLET_KEY is not set, so nothing can pay the fee");
  }
  // Our config: a broken gas key throws instead of failing the invoice.
  const gas = await loadSolSigner(
    openSecret("solana-gas-wallet-key", env.solGasWalletKey),
  );

  const final = await getAtaBalance(depositAddress, asset, "finalized");
  const seen = await getAtaBalance(depositAddress, asset, "confirmed");
  if (final === undefined || seen === undefined) {
    return wait("deposit token balance lookup failed");
  }
  if (final.frozen) {
    return stop(`the deposit's ${asset.name} account ${final.ata} is frozen by the token issuer, so nobody can move it. ${fundsAt} Contact the issuer.`);
  }
  // Send exactly what is there; a payment still arriving would be left behind.
  if (seen.amount !== final.amount) return wait("a payment to the deposit is not final yet");
  if (final.amount < input.minimumTotal) return wait("the deposit holds less than expected");

  const tokenPlan = planTokenPayout(final.amount, feeRate);
  if (tokenPlan === undefined) return wait("too small after the platform fee");

  let platformDestination: { ata: Address; exists: boolean } | undefined;
  if (tokenPlan.platformFee > 0n) {
    const checked = await checkTokenDestination(platformAddress, asset);
    if (checked === undefined) return wait("platform token account lookup failed");
    if ("problem" in checked) {
      throw new Error(`Platform can't receive ${asset.name}: ${checked.problem}`);
    }
    platformDestination = checked;
  }

  const picked = await pickReceiver(async (address): Promise<ReceiverPlan> => {
    const wallet = await getSolWallet(address);
    if (wallet === undefined) return { kind: "wait", why: "receiver account lookup failed" };
    if (wallet === "not-a-wallet") return { kind: "problem", text: notAWallet(address) };

    const destination = await checkTokenDestination(address, asset);
    if (destination === undefined) return { kind: "wait", why: "receiver token account lookup failed" };
    if ("problem" in destination) return { kind: "problem", text: destination.problem };

    return {
      kind: "ok",
      networkFee: 0n,
      platformFee: tokenPlan.platformFee,
      merchantAmount: tokenPlan.merchantAmount,
      receiverAta: destination.ata,
      receiverExists: destination.exists,
    };
  });
  if (picked.kind !== "picked") return picked;

  const receiverAta = picked.plan.receiverAta;
  if (receiverAta === undefined) throw new Error("receiver token account missing from the plan");

  const tokenRent = await getSolRentExemption(TOKEN_ACCOUNT_SIZE);
  if (tokenRent === undefined) return wait("token account rent lookup failed");

  // What the gas wallet spends, at most. It must also keep at least
  // rentMinimum itself, or Solana rejects the tx.
  const gasFee = getSolNetworkFee(2n, TOKEN_PAYOUT_COMPUTE_UNITS, priorityFee);
  let accountsToCreate = picked.plan.receiverExists ? 0n : 1n;
  if (platformDestination && !platformDestination.exists) accountsToCreate += 1n;
  const gasNeeded = gasFee + accountsToCreate * tokenRent + rentMinimum;

  const gasBalance = await getSolBalance(gas.address, "confirmed");
  if (gasBalance === undefined) return wait("gas wallet balance lookup failed");
  if (gasBalance < gasNeeded) {
    return wait(`gas wallet ${gas.address} holds ${gasBalance} lamports but needs ${gasNeeded}; send it SOL`);
  }

  const lifetime = await getSolLatestBlockhash("confirmed");
  if (lifetime === undefined) return wait("blockhash lookup failed");

  try {
    const signed = await signTokenPayout({
      gas,
      deposit,
      asset,
      depositAta: final.ata,
      merchant: toSolAddress(picked.receiver),
      merchantAta: receiverAta,
      platform: toSolAddress(platformAddress),
      platformAta: platformDestination?.ata,
      platformFee: tokenPlan.platformFee,
      merchantAmount: tokenPlan.merchantAmount,
      priorityFee,
      lifetime,
      // A swap refund comes back to this account, so keep it open.
      closeDepositAccount: picked.swap === undefined,
    });
    return {
      kind: "ready",
      ...signed,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
      merchantAmount: tokenPlan.merchantAmount,
      networkFee: 0n,
      platformFee: tokenPlan.platformFee,
      swap: picked.swap,
    };
  } catch (error) {
    return stop(`signing failed (${error instanceof Error ? error.message : "unknown error"}). Nothing was sent. ${fundsAt} Investigate before retrying.`);
  }
}

// ---------- Saved tx ----------

// tx.raw for Solana holds the signed tx and the block height after which it
// can never land. Both are needed to decide "resend" vs "rebuild".
const savedSolTxSchema = z.object({
  wire: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  lastValidBlockHeight: u64String,
});

function savedTxFields(prepared: Extract<PreparedPayout, { kind: "ready" }>) {
  return {
    "tx.out": prepared.signature,
    "tx.raw": JSON.stringify({
      wire: prepared.wire,
      lastValidBlockHeight: String(prepared.lastValidBlockHeight),
    }),
    // Swap: what the merchant gets is known only when NEAR finishes
    // (updateSwapStatus sets it).
    received_amount: prepared.swap ? "0" : prepared.merchantAmount.toString(),
    network_fee: prepared.networkFee.toString(),
    platform_fee: prepared.platformFee.toString(),
    ...(prepared.swap ? swapFieldsToSave(prepared.swap) : {}),
  };
}

function parseSavedSolTx(raw: string | undefined | null) {
  if (!raw) return undefined;
  try {
    const parsed = savedSolTxSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    return {
      wire: parsed.data.wire,
      lastValidBlockHeight: BigInt(parsed.data.lastValidBlockHeight),
    };
  } catch {
    return undefined;
  }
}

async function broadcastSolanaPayout(
  invoiceId: string,
  name: string,
  wire: string,
  signature: string,
) {
  const sent = await sendSolTransaction(wire);
  if (sent === signature) {
    console.log(`${name} payout broadcast:`, invoiceId, signature);
  } else if (sent !== undefined) {
    // The signature is part of the signed tx, so this can't happen unless something is broken.
    console.error(`${name} broadcast returned another signature:`, invoiceId, signature, sent);
  }
  // post() already logs why a send failed.
}

// ---------- The payout ----------

export async function transferSolanaToMerchant(
  invoiceId: string,
  platformAddress: string,
) {
  try {
    const invoice = await Invoice.findOne({
      invoice_id: invoiceId,
      crypto: { $in: SOL_CRYPTOS },
      status: { $in: ["confirmed", "processing"] },
    })
      .select("+private.private_key +tx.raw")
      .exec();
    if (!invoice) return;

    const crypto = invoice.crypto;
    if (!isSolCrypto(crypto)) return;
    const asset = getSolAsset(crypto);

    // Our own config, not the invoice: never fail an invoice for it.
    if (!isAddress(platformAddress)) {
      throw new Error("Platform SOL address is not a valid Solana address");
    }

    async function markFailed(
      fromStatus: "confirmed" | "processing",
      reason: string,
    ) {
      const result = await Invoice.updateOne(
        { invoice_id: invoiceId, crypto, status: fromStatus },
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
          `${asset.name} payout: could not mark failed, invoice is no longer ${fromStatus}:`,
          invoiceId,
          reason,
        );
        return;
      }
      console.error(`${asset.name} payout failed:`, invoiceId, reason);
    }

    const isSwap = invoice.to_crypto !== crypto;

    // Arrow function, not `function`: TypeScript keeps the checks above
    // (invoice not null, crypto is a Solana coin) inside arrow functions.
    // The deposit must still hold the invoice amount. On a rebuild, less
    // means the old tx probably landed and this RPC node can't see it yet.
    const prepare = () =>
      prepareSolanaPayout({
        invoiceId,
        crypto,
        asset,
        depositAddress: invoice.address,
        merchantAddress: invoice.to_address,
        platformAddress,
        userId: invoice.user_id,
        feePaidByPayer: invoice.fee_paid_by_payer,
        toCrypto: invoice.to_crypto,
        sealedDepositKey: invoice.private?.private_key,
        minimumTotal: BigInt(invoice.amount),
      });

    // ----- confirmed: sign, save, then send -----
    if (invoice.status === "confirmed") {
      const prepared = await prepare();
      if (prepared.kind === "wait") return;
      if (prepared.kind === "stop") {
        return await markFailed("confirmed", prepared.reason);
      }

      // Save the signed tx before sending it, so a crash can't lose it.
      const claimed = await Invoice.findOneAndUpdate(
        { invoice_id: invoiceId, crypto, status: "confirmed" },
        {
          $set: {
            status: "processing",
            "timestamps.processing": Date.now(),
            ...savedTxFields(prepared),
          },
        },
        { returnDocument: "after" },
      ).exec();

      if (claimed === null) {
        console.warn("Another run claimed it first", invoiceId);
        return;
      }

      await broadcastSolanaPayout(invoiceId, asset.name, prepared.wire, prepared.signature);
      return;
    }

    // ----- processing: check, resend, or rebuild -----
    const signature = invoice.tx?.out;
    const saved = parseSavedSolTx(invoice.tx?.raw);

    if (!signature || saved === undefined) {
      await Invoice.updateOne(
        { invoice_id: invoiceId, crypto, status: "processing" },
        {
          $set: {
            review_reason: `Invoice is processing but has no saved ${asset.name} transaction. The claim always saves it, so this is a bug or a manual DB edit. Funds may still be at deposit address ${invoice.address}; check a block explorer before sending anything.`,
          },
        },
      ).exec();
      console.error(
        `${asset.name} invoice is processing but has no saved tx; needs review:`,
        invoiceId,
      );
      return;
    }

    const noteIfStuck = async () => {
      const processingAt = invoice.timestamps?.processing;
      if (processingAt == null || Date.now() - processingAt < STUCK_TX_REVIEW_MS) {
        return;
      }

      const reason = `${asset.name} payout is not finalized after 24 hours (latest tx ${signature}). Funds stay at deposit address ${invoice.address} until a payout lands. Expired txs are rebuilt automatically; check the logs (RPC errors, gas wallet balance). Do not pay the merchant from another wallet: the automatic payout can still land.`;

      const result = await Invoice.updateOne(
        {
          invoice_id: invoiceId,
          crypto,
          status: "processing",
          review_reason: { $ne: reason },
        },
        { $set: { review_reason: reason } },
      ).exec();

      if (result.modifiedCount === 1) {
        console.error(`${asset.name} payout stuck; needs review:`, invoiceId, signature);
      }
    };

    // Order matters: read the finalized height BEFORE the status. If the
    // height is already past lastValidBlockHeight and the tx is still not
    // found after that, it can never land.
    const finalizedHeight = await getSolBlockHeight("finalized");
    if (finalizedHeight === undefined) return await noteIfStuck();

    const status = await getSolSignatureStatus(signature);
    if (status === undefined) return await noteIfStuck();

    if (status !== null) {
      // Landed. Only act once it can't roll back.
      if (status.confirmationStatus !== "finalized") return await noteIfStuck();

      if (status.err !== null) {
        const error = JSON.stringify(status.err).slice(0, 200);
        // A failed tx moves nothing, but its fee is still paid.
        const nextStep =
          asset.kind === "sol"
            ? `The fee (${invoice.network_fee} lamports) came out of the deposit; the rest is still at deposit address ${invoice.address}. The deposit is now below the invoice amount, so an automatic retry would wait forever: check the error, then pay out manually.`
            : `Only the gas wallet's SOL fee was spent; the ${asset.name} is still at deposit address ${invoice.address}. Check the error and the receiving accounts, then set the status back to "confirmed" to try again.`;
        return await markFailed(
          "processing",
          `${asset.name} payout tx ${signature} failed on chain (${error}). ${nextStep}`,
        );
      }

      // Swap: the coins reached NEAR. NEAR's status completes the invoice
      // (updateSwapStatus in swap/near.ts).
      if (isSwap) return;

      const result = await Invoice.updateOne(
        { invoice_id: invoiceId, crypto, status: "processing", "tx.out": signature },
        {
          $set: {
            status: "completed",
            "timestamps.completed": Date.now(),
            review_reason: "",
          },
        },
      ).exec();

      if (result.modifiedCount > 0) {
        console.log(`${asset.name} payout completed:`, invoiceId, signature);
      }
      return;
    }

    if (finalizedHeight <= saved.lastValidBlockHeight) {
      // Not seen yet, but it can still land: send the same signed tx again.
      await sendSolTransaction(saved.wire);
      return await noteIfStuck();
    }

    // Expired without landing. A new tx is safe now: the old one can never
    // land. prepare() rebuilds only if the money is still at the deposit.
    // A swap also gets a fresh NEAR quote: nothing reached the old one.
    const prepared = await prepare();
    if (prepared.kind === "wait") return await noteIfStuck();
    if (prepared.kind === "stop") {
      return await markFailed("processing", prepared.reason);
    }

    const result = await Invoice.updateOne(
      { invoice_id: invoiceId, crypto, status: "processing", "tx.out": signature },
      { $set: savedTxFields(prepared) },
    ).exec();

    if (result.modifiedCount === 0) {
      console.warn("Another run rebuilt it first", invoiceId);
      return;
    }

    console.log(`${asset.name} payout expired unsent; rebuilt:`, invoiceId, signature, "->", prepared.signature);
    await broadcastSolanaPayout(invoiceId, asset.name, prepared.wire, prepared.signature);
  } catch (error) {
    console.error(
      "Solana payout could not finish; invoice state was preserved:",
      invoiceId,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}
