import * as btc from "@scure/btc-signer";

export type BitcoinAddressType = "p2pkh" | "p2sh" | "p2wpkh" | "p2tr";

export interface BitcoinAddress {
  address: string;
  type: BitcoinAddressType;
}

const DECODE_TYPE_ADDRESS_TYPE: Record<string, BitcoinAddressType> = {
  pkh: "p2pkh",
  sh: "p2sh",
  wpkh: "p2wpkh",
  tr: "p2tr",
};

export function parseBitcoinAddress(input: string): BitcoinAddress | undefined {
  try {
    let trimmed = input.trim();

    // in BIP-173 address "Bc1QCr8te" mixed upper n lower case writted is invalid
    // decode will throw if address is mixed
    const decode = btc.Address().decode(trimmed);
    const type = DECODE_TYPE_ADDRESS_TYPE[decode.type];

    if (!type) return undefined;

    const isBech32 = type === "p2wpkh" || type === "p2tr";
    const address = isBech32 ? trimmed.toLowerCase() : trimmed;

    return { address, type };
  } catch {
    return undefined;
  }
}
