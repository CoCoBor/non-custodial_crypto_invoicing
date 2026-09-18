import bitcore from "bitcore-lib";
import { SealedSecret, sealSecret } from "../security/secret-envelope.js";

export function generateBtcAddress(): {
  address: string;
  encryptedPrivateKey: SealedSecret;
} {
  const privateKey = new bitcore.PrivateKey();

  return {
    address: privateKey.toAddress().toString(),
    encryptedPrivateKey: sealSecret("bitcoin-deposit-key", privateKey.toWIF()),
  };
}

export function verify(){
    
}