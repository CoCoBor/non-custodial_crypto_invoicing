import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintEncoder,
  getMintToInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

import { createSolanaRpc, type SolanaRpc } from "../../../src/chains/solana-rpc.js";

// A throwaway solana-test-validator (Agave) for the Solana payout tests.
// Never mainnet: the validator makes its own chain from genesis. The test
// mints are loaded at the real USDT/USDC mint addresses (--account), with a
// mint authority the test holds, so the adapters run with cryptos.json as is.
//
// Slots are shortened (--ticks-per-slot), so "finalized" (about 32 slots
// behind) and a blockhash's expiry (150 blocks) come within seconds.

const TICKS_PER_SLOT = 8;

const INSTALL_HINT =
  "solana-test-validator was not found, so the Solana payout tests are skipped. " +
  "Install Agave v4.4.1 (https://github.com/anza-xyz/agave/releases/tag/v4.4.1, check the asset's sha256), " +
  "then set SOLANA_TEST_VALIDATOR to the absolute path of its bin/solana-test-validator, or put it on PATH.";

/** The validator binary: SOLANA_TEST_VALIDATOR (absolute path), else PATH. */
export function findValidator(): string | undefined {
  const configured = process.env.SOLANA_TEST_VALIDATOR?.trim();
  if (configured) return isAbsolute(configured) && existsSync(configured) ? configured : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "solana-test-validator");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function validatorMissing(): string | undefined {
  const configured = process.env.SOLANA_TEST_VALIDATOR?.trim();
  if (configured && findValidator() === undefined) {
    return `SOLANA_TEST_VALIDATOR is "${configured}", which is not an absolute path to an existing file. ${INSTALL_HINT}`;
  }
  return findValidator() === undefined ? INSTALL_HINT : undefined;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/** A short directory: a long ledger path breaks the validator's admin socket. */
async function shortTempDir(): Promise<string> {
  const base = tmpdir().length <= 40 ? tmpdir() : "/tmp";
  return await mkdtemp(join(base, "msol-"));
}

export type TestMint = { address: string; decimals: number };

export type SolanaValidator = Awaited<ReturnType<typeof startValidator>>;

export async function startValidator(options: { mints: TestMint[] }) {
  const binary = findValidator();
  if (binary === undefined) throw new Error(INSTALL_HINT);

  const dir = await shortTempDir();
  const mintAuthority = await generateKeyPairSigner();
  const accountArgs: string[] = [];
  for (const mint of options.mints) {
    const data = getMintEncoder().encode({
      mintAuthority: mintAuthority.address,
      supply: 0n,
      decimals: mint.decimals,
      isInitialized: true,
      freezeAuthority: null,
    });
    const file = join(dir, `${mint.address}.json`);
    await writeFile(
      file,
      JSON.stringify({
        pubkey: mint.address,
        account: {
          lamports: 1_461_600,
          data: [getBase64Decoder().decode(data), "base64"],
          owner: TOKEN_PROGRAM_ADDRESS,
          executable: false,
          rentEpoch: 0,
          space: data.length,
        },
      }),
    );
    accountArgs.push("--account", mint.address, file);
  }

  const [rpcPort, faucetPort, gossipPort] = [await freePort(), await freePort(), await freePort()];
  const dynamicBase = 30_000 + Math.floor(Math.random() * 300) * 100;
  const child = spawn(
    binary,
    [
      "--ledger", join(dir, "l"),
      "--reset",
      "--quiet",
      "--bind-address", "127.0.0.1",
      "--rpc-port", String(rpcPort),
      "--faucet-port", String(faucetPort),
      "--gossip-port", String(gossipPort),
      "--dynamic-port-range", `${dynamicBase}-${dynamicBase + 100}`,
      "--ticks-per-slot", String(TICKS_PER_SLOT),
      ...accountArgs,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4_000);
  });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(dir, { recursive: true, force: true });
  };

  const url = `http://127.0.0.1:${rpcPort}`;

  // Test-side calls throw on any error; the adapter gets the real client.
  async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  try {
    const started = Date.now();
    for (;;) {
      try {
        if ((await rpc<string>("getHealth")) === "ok" && (await rpc<number>("getBlockHeight", [{ commitment: "finalized" }])) > 0) break;
      } catch (error) {
        if (child.exitCode !== null) throw new Error(`solana-test-validator exited: ${stderr}`);
        if (Date.now() - started > 60_000) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    await stop();
    throw error;
  }

  const client: SolanaRpc = createSolanaRpc({ url, sendApiKey: false });

  async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 30_000) {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function waitFinalized(signature: string) {
    await waitFor(async () => {
      const status = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      const value = status.value[0];
      if (value?.err) throw new Error(`${signature} failed: ${JSON.stringify(value.err)}`);
      return value?.confirmationStatus === "finalized";
    }, `${signature} to finalize`);
  }

  async function balance(owner: string): Promise<bigint> {
    return BigInt((await rpc("getBalance", [owner, { commitment: "confirmed" }])).value);
  }

  const ataOf = async (owner: string, mint: string): Promise<Address> =>
    (await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

  async function tokenBalance(mint: string, owner: string): Promise<bigint> {
    const ata = await ataOf(owner, mint);
    const info = await rpc("getAccountInfo", [ata, { commitment: "confirmed", encoding: "jsonParsed" }]);
    return info.value === null ? 0n : BigInt(info.value.data.parsed.info.tokenAmount.amount);
  }

  /** Signs with the fee payer and the instructions' signers, sends, and waits until it is finalized. */
  async function send(feePayer: KeyPairSigner, instructions: Instruction[]): Promise<string> {
    const latest = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash(latest.blockhash), lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    await rpc("sendTransaction", [getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }]);
    await waitFinalized(signature);
    return signature;
  }

  /** Airdrops lamports to `to` and waits until they are finalized. */
  async function airdrop(to: string, lamports: bigint): Promise<string> {
    const signature = await rpc<string>("requestAirdrop", [to, Number(lamports), { commitment: "confirmed" }]);
    await waitFinalized(signature);
    return signature;
  }

  // One funded wallet stands in for every payer.
  const payer = await generateKeyPairSigner();
  await airdrop(payer.address, 1_000n * 1_000_000_000n);

  /** A payer's SOL transfer to `to`, finalized. */
  async function pay(to: string, lamports: bigint): Promise<string> {
    return await send(payer, [getTransferSolInstruction({ source: payer, destination: address(to), amount: lamports })]);
  }

  /**
   * A payer's token payment to `owner`, the way a wallet sends it: create the
   * receiver's associated token account if it is missing (the payer pays its
   * rent), then transfer from the payer's own account. Finalized.
   */
  async function payToken(mint: TestMint, owner: string, amount: bigint): Promise<string> {
    const payerAta = await ataOf(payer.address, mint.address);
    await send(payer, [
      getCreateAssociatedTokenIdempotentInstruction({ payer, ata: payerAta, owner: payer.address, mint: address(mint.address) }),
      getMintToInstruction({ mint: address(mint.address), token: payerAta, mintAuthority, amount }),
    ]);
    const ata = await ataOf(owner, mint.address);
    return await send(payer, [
      getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner: address(owner), mint: address(mint.address) }),
      getTransferCheckedInstruction({
        source: payerAta,
        mint: address(mint.address),
        destination: ata,
        authority: payer,
        amount,
        decimals: mint.decimals,
      }),
    ]);
  }

  /** Creates `owner`'s associated token account (empty), paid by the test payer. */
  async function createTokenAccount(mint: TestMint, owner: string): Promise<void> {
    const ata = await ataOf(owner, mint.address);
    await send(payer, [getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner: address(owner), mint: address(mint.address) })]);
  }

  return {
    url,
    client,
    rpc,
    stop,
    balance,
    tokenBalance,
    ataOf,
    airdrop,
    pay,
    payToken,
    createTokenAccount,
    send,
    waitFor,
    waitFinalized,
    payer,
  };
}

/** Lamports a 0-byte or 165-byte (token) account needs, from the node. */
export async function rentExempt(node: SolanaValidator, space: number): Promise<bigint> {
  return BigInt(await node.rpc<number>("getMinimumBalanceForRentExemption", [space]));
}
