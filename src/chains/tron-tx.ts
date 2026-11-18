import { AbiCoder, id, sha256, SigningKey } from "ethers";

import { evmFormOfTronAddress, tronAddressBytes } from "./tron-address.js";

// Tron transactions, built and signed here rather than by the node, so a
// node can't change what we sign. The wire format is protobuf
// (java-tron protocol/core/Tron.proto and contract/*.proto); only the
// fields we use are written. txID = sha256(raw_data bytes), and the
// signature is secp256k1 over the txID: r ‖ s ‖ (recovery id + 27).

// ---------- Minimal protobuf writer ----------

function varint(value: bigint): Buffer {
  if (value < 0n) throw new RangeError("negative varint");
  const out: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

const tag = (field: number, wireType: 0 | 2) => varint(BigInt((field << 3) | wireType));
const intField = (field: number, value: bigint) => (value === 0n ? Buffer.alloc(0) : Buffer.concat([tag(field, 0), varint(value)]));
const bytesField = (field: number, value: Uint8Array) =>
  value.length === 0 ? Buffer.alloc(0) : Buffer.concat([tag(field, 2), varint(BigInt(value.length)), value]);

const TRANSFER_CONTRACT = 1n;
const TRIGGER_SMART_CONTRACT = 31n;

function addressBytes(address: string): Buffer {
  const bytes = tronAddressBytes(address);
  if (bytes === undefined) throw new Error(`not a Tron address: ${address}`);
  return bytes;
}

// ---------- Building ----------

/** The block a transaction refers to (TaPoS): it is valid only on a chain holding that block. */
export type RefBlock = { number: bigint; blockId: string; timestamp: number };

export type TronCall =
  | { kind: "trx"; from: string; to: string; amount: bigint }
  | { kind: "trc20_transfer"; from: string; contract: string; to: string; amount: bigint; feeLimit: bigint };

export type SignedTronTx = {
  txid: string;
  /** Full Transaction protobuf (raw_data + signature), hex: what /wallet/broadcasthex takes. */
  hex: string;
  /** Unix ms after which no block can include it. */
  expiration: number;
};

const TRANSFER_SELECTOR = id("transfer(address,uint256)").slice(2, 10);

/** ABI call data of transfer(to, amount), hex without 0x. */
export function trc20TransferData(to: string, amount: bigint): string {
  const evmTo = evmFormOfTronAddress(to);
  if (evmTo === undefined) throw new Error(`not a Tron address: ${to}`);
  return TRANSFER_SELECTOR + AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [evmTo, amount]).slice(2);
}

function contractOf(call: TronCall): Buffer {
  let typeName: string;
  let type: bigint;
  let value: Buffer;
  if (call.kind === "trx") {
    if (call.amount <= 0n) throw new RangeError("a TRX transfer needs a positive amount");
    type = TRANSFER_CONTRACT;
    typeName = "TransferContract";
    value = Buffer.concat([bytesField(1, addressBytes(call.from)), bytesField(2, addressBytes(call.to)), intField(3, call.amount)]);
  } else {
    type = TRIGGER_SMART_CONTRACT;
    typeName = "TriggerSmartContract";
    value = Buffer.concat([
      bytesField(1, addressBytes(call.from)),
      bytesField(2, addressBytes(call.contract)),
      bytesField(4, Buffer.from(trc20TransferData(call.to, call.amount), "hex")),
    ]);
  }
  const any = Buffer.concat([bytesField(1, Buffer.from(`type.googleapis.com/protocol.${typeName}`)), bytesField(2, value)]);
  return Buffer.concat([intField(1, type), bytesField(2, any)]);
}

/** raw_data bytes. `now` is the transaction's own timestamp (unix ms). */
export function encodeRawData(call: TronCall, ref: RefBlock, expiration: number, now: number): Buffer {
  const blockId = Buffer.from(ref.blockId, "hex");
  if (blockId.length !== 32) throw new Error("block id must be 32 bytes");
  const number = Buffer.alloc(8);
  number.writeBigUInt64BE(ref.number);
  return Buffer.concat([
    bytesField(1, number.subarray(6, 8)), // ref_block_bytes
    bytesField(4, blockId.subarray(8, 16)), // ref_block_hash
    intField(8, BigInt(expiration)),
    bytesField(11, contractOf(call)),
    intField(14, BigInt(now)),
    ...(call.kind === "trc20_transfer" ? [intField(18, call.feeLimit)] : []),
  ]);
}

export function signTronTx(
  call: TronCall,
  privateKey: string,
  input: { ref: RefBlock; expiration: number; now: number },
): SignedTronTx {
  const raw = encodeRawData(call, input.ref, input.expiration, input.now);
  const txid = sha256(raw);
  const sig = new SigningKey(privateKey).sign(txid);
  const signature = Buffer.concat([
    Buffer.from(sig.r.slice(2), "hex"),
    Buffer.from(sig.s.slice(2), "hex"),
    Buffer.from([sig.v]), // 27 or 28
  ]);
  const hex = Buffer.concat([bytesField(1, raw), bytesField(2, signature)]).toString("hex");
  return { txid: txid.slice(2), hex, expiration: input.expiration };
}

// java-tron charges bandwidth for the serialized transaction plus 64 bytes
// per contract for its result (MAX_RESULT_SIZE_IN_TX).
export const bandwidthBytes = (signed: SignedTronTx) => BigInt(signed.hex.length / 2 + 64);
