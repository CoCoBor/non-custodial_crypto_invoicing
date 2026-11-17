import litecore from "bitcore-lib-ltc";
import { SealedSecret, sealSecret } from "../security/secret-envelope.js";

// A fresh Litecoin deposit address (P2PKH, starts with "L").
// The payout in transactions/ltc.ts sizes its fee for this address type.
export function generateLtcAddress(): {
  address: string;
  encryptedPrivateKey: SealedSecret;
} {
  const network = litecore.Networks.livenet;
  const privateKey = new litecore.PrivateKey(undefined, network);

  return {
    address: privateKey.toAddress().toString(),
    encryptedPrivateKey: sealSecret("litecoin-deposit-key", privateKey.toWIF()),
  };
}
