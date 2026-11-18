import { Blockchain, createShardAccount, type SandboxContract, type TreasuryContract } from "@ton/sandbox";
import {
  Address,
  beginCell,
  Cell,
  contractAddress,
  Dictionary,
  SendMode,
  storeTransaction,
  toNano,
  type Transaction,
  type TupleItem,
} from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";

import minterBuild from "./JettonMinter.compiled.json" with { type: "json" };
import walletBuild from "./JettonWallet.compiled.json" with { type: "json" };

// @ton/sandbox behind the toncenter v2 calls the TON adapters make, plus
// TON's stablecoin jetton (github.com/ton-blockchain/stablecoin-contract,
// commit 5a3b500, MIT: see LICENSE-stablecoin-contract), the design USDT on
// TON uses. No network, no real money.

type TonApi = (method: string, request: { query?: Record<string, string>; body?: unknown }) => Promise<unknown>;

const OP = {
  transfer: 0x0f8a7ea5,
  internalTransfer: 0x178d4519,
  mint: 0x642b7d07,
  setStatus: 0xeed236d3,
};

const W5_CODE_HASH = WalletContractV5R1.create({ workchain: 0, publicKey: Buffer.alloc(32) }).init.code.hash();
const MINTER_CODE = Cell.fromHex(minterBuild.hex);
const WALLET_CODE = Cell.fromHex(walletBuild.hex);

export function accountOf(tx: Transaction) {
  return new Address(0, Buffer.from(tx.address.toString(16).padStart(64, "0"), "hex"));
}

const toBoc = (cell: Cell) => cell.toBoc().toString("base64");
const txBoc = (tx: Transaction) => toBoc(beginCell().store(storeTransaction(tx)).endCell());

function stackItemIn(item: unknown): TupleItem {
  const [type, value] = item as [string, string];
  if (type === "num") return { type: "int", value: BigInt(value) };
  if (type === "tvm.Slice") return { type: "slice", cell: Cell.fromBase64(value) };
  if (type === "tvm.Cell") return { type: "cell", cell: Cell.fromBase64(value) };
  throw new Error(`emulator: unknown stack item ${type}`);
}

function stackItemOut(item: TupleItem): unknown {
  switch (item.type) {
    case "int":
      return ["num", item.value < 0n ? `-0x${(-item.value).toString(16)}` : `0x${item.value.toString(16)}`];
    case "cell":
    case "slice":
    case "builder":
      return ["cell", { bytes: toBoc(item.cell) }];
    case "null":
      return ["null"];
    default:
      return ["unsupported", null];
  }
}

export async function createTonEmulator() {
  const chain = await Blockchain.create();
  chain.now = Math.floor(Date.now() / 1000);
  const history: Transaction[] = [];
  /** Switches a test can flip to make the API misbehave. */
  const options = { sendFails: false, listingLimit: Infinity };

  const record = (result: { transactions: Transaction[] }) => {
    history.push(...result.transactions);
  };

  const api: TonApi = async (method, request) => {
    if (method === "sendBoc") {
      if (options.sendFails) return undefined;
      try {
        record(await chain.sendMessage(Cell.fromBase64((request.body as { boc: string }).boc)));
        return {};
      } catch {
        return undefined; // the wallet refused it, e.g. a used seqno or no balance to pay for it
      }
    }

    if (method === "runGetMethod") {
      const body = request.body as { address: string; method: string; stack: unknown[] };
      const address = Address.parse(body.address);
      const contract = await chain.getContract(address);
      if (contract.accountState?.type !== "active") return { gas_used: 0, exit_code: -13, stack: [] };
      try {
        const result = await chain.runGetMethod(address, body.method, body.stack.map(stackItemIn));
        return { gas_used: Number(result.gasUsed), exit_code: result.exitCode, stack: result.stack.map(stackItemOut) };
      } catch (error) {
        const exitCode = (error as { exitCode?: number }).exitCode ?? 1;
        return { gas_used: 0, exit_code: exitCode, stack: [] };
      }
    }

    if (method === "tryLocateResultTx") {
      const source = Address.parse(request.query!.source!);
      const destination = Address.parse(request.query!.destination!);
      const lt = BigInt(request.query!.created_lt!);
      const found = history.find(
        (tx) =>
          accountOf(tx).equals(destination) &&
          tx.inMessage?.info.type === "internal" &&
          tx.inMessage.info.src.equals(source) &&
          tx.inMessage.info.createdLt === lt,
      );
      return found ? { data: txBoc(found), utime: found.now } : undefined;
    }

    const address = request.query?.address ? Address.parse(request.query.address) : undefined;
    if (address === undefined) throw new Error(`emulator: no address for ${method}`);
    const contract = await chain.getContract(address);
    const state = contract.accountState;
    const accountState = state?.type === "active" ? "active" : state?.type === "frozen" ? "frozen" : "uninitialized";

    switch (method) {
      case "getAddressInformation":
        return {
          balance: contract.balance.toString(),
          state: accountState,
          code: state?.type === "active" && state.state.code ? toBoc(state.state.code) : "",
          data: state?.type === "active" && state.state.data ? toBoc(state.state.data) : "",
          sync_utime: chain.now,
        };
      case "getWalletInformation":
        return {
          wallet: state?.type === "active" && state.state.code?.hash().equals(W5_CODE_HASH) === true,
          account_state: accountState,
        };
      case "getTransactions": {
        const limit = Math.min(Number(request.query?.limit), options.listingLimit);
        return history
          .filter((tx) => accountOf(tx).equals(address))
          .reverse()
          .slice(0, limit)
          .map((tx) => ({ data: txBoc(tx) }));
      }
      default:
        throw new Error(`emulator: no ${method}`);
    }
  };

  async function balanceOf(address: Address) {
    return (await chain.getContract(address)).balance;
  }

  async function newWallet() {
    const words = await mnemonicNew(24);
    const keyPair = await mnemonicToPrivateKey(words);
    const contract = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
    return { words, contract, secretKey: keyPair.secretKey, address: contract.address };
  }

  /** A W5 wallet that has sent once, so it is deployed, like a merchant's. */
  async function deployedWallet(funder: SandboxContract<TreasuryContract>) {
    const wallet = await newWallet();
    record(await funder.send({ to: wallet.address, value: toNano("1"), bounce: false }));
    record(
      await chain.openContract(wallet.contract).sendTransfer({
        seqno: 0,
        secretKey: wallet.secretKey,
        messages: [],
        sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
        timeout: chain.now! + 60,
      }),
    );
    return wallet;
  }

  /**
   * A stablecoin jetton minter with `admin` as its admin, placed at `at`
   * when given (e.g. the real USDT master's address), else at its own
   * address. The wallet code is a library cell, as on mainnet USDT.
   */
  async function deployJetton(admin: SandboxContract<TreasuryContract>, at?: Address) {
    const libs = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    const existing = chain.libs;
    if (existing) {
      for (const [hash, code] of existing.beginParse().loadDictDirect(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell())) {
        libs.set(hash, code);
      }
    }
    libs.set(WALLET_CODE.hash(), WALLET_CODE);
    chain.libs = beginCell().storeDictDirect(libs).endCell();
    const walletCodeRef = beginCell().storeUint(2, 8).storeBuffer(WALLET_CODE.hash()).endCell({ exotic: true });

    const data = beginCell()
      .storeCoins(0)
      .storeAddress(admin.address)
      .storeAddress(null)
      .storeRef(walletCodeRef)
      .storeRef(beginCell().storeStringTail(`test-jetton-${Math.random()}`).endCell())
      .endCell();
    // The minter keeps 1 TON on every mint (raw_reserve), so it needs more than that.
    const balance = toNano("2");
    const master = at ?? contractAddress(0, { code: MINTER_CODE, data });
    await chain.setShardAccount(master, createShardAccount({ address: master, code: MINTER_CODE, data, balance }));

    async function walletOf(owner: Address): Promise<Address> {
      const result = await chain.runGetMethod(master, "get_wallet_address", [
        { type: "slice", cell: beginCell().storeAddress(owner).endCell() },
      ]);
      return result.stackReader.readAddress();
    }

    async function balanceOfOwner(owner: Address): Promise<bigint> {
      const wallet = await walletOf(owner);
      const contract = await chain.getContract(wallet);
      if (contract.accountState?.type !== "active") return 0n;
      return (await chain.runGetMethod(wallet, "get_wallet_data")).stackReader.readBigNumber();
    }

    async function mint(to: Address, amount: bigint) {
      const internalTransfer = beginCell()
        .storeUint(OP.internalTransfer, 32)
        .storeUint(0, 64)
        .storeCoins(amount)
        .storeAddress(null)
        .storeAddress(admin.address)
        .storeCoins(0)
        .storeMaybeRef(null)
        .endCell();
      const body = beginCell()
        .storeUint(OP.mint, 32)
        .storeUint(0, 64)
        .storeAddress(to)
        .storeCoins(toNano("0.1"))
        .storeRef(internalTransfer)
        .endCell();
      record(await admin.send({ to: master, value: toNano("0.2"), bounce: true, body }));
    }

    /** `from` sends jettons from its jetton wallet, as a payer's wallet app does. */
    async function transfer(
      from: SandboxContract<TreasuryContract>,
      to: Address,
      amount: bigint,
      options: { forwardTon?: bigint; value?: bigint; bounce?: boolean } = {},
    ) {
      const body = beginCell()
        .storeUint(OP.transfer, 32)
        .storeUint(Math.floor(Math.random() * 2 ** 32), 64)
        .storeCoins(amount)
        .storeAddress(to)
        .storeAddress(from.address)
        .storeMaybeRef(null)
        .storeCoins(options.forwardTon ?? 1n)
        .storeMaybeRef(null)
        .endCell();
      record(
        await from.send({
          to: await walletOf(from.address),
          value: options.value ?? toNano("0.1"),
          bounce: options.bounce ?? true,
          body,
        }),
      );
    }

    /** The admin locks a jetton wallet: 1 = can't send, 2 = can't receive. */
    async function setStatus(owner: Address, status: number) {
      const setStatusBody = beginCell().storeUint(OP.setStatus, 32).storeUint(0, 64).storeUint(status, 4).endCell();
      const callTo = beginCell()
        .storeUint(0x235caf52, 32)
        .storeUint(0, 64)
        .storeAddress(owner)
        .storeCoins(toNano("0.1"))
        .storeRef(setStatusBody)
        .endCell();
      record(await admin.send({ to: master, value: toNano("0.2"), bounce: true, body: callTo }));
    }

    return { master, walletOf, balanceOf: balanceOfOwner, mint, transfer, setStatus };
  }

  return { chain, history, options, api, record, balanceOf, newWallet, deployedWallet, deployJetton };
}
