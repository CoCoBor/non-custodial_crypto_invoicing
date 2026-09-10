import bitcore from "bitcore-lib";

import {
  sealSecret,
  type SealedSecret,
} from "../../security/secret-envelope.js";

export interface BitcoinDepositAddress {
  address: string;
  encryptedPrivateKey: SealedSecret;
}

export function generateDepositAddress(): BitcoinDepositAddress {
  const privateKey = new bitcore.PrivateKey();

  const address = privateKey.toAddress().toString();
  const wif = privateKey.toWIF();

  const encryptedPrivateKey = sealSecret(
    "bitcoin-deposit-key",
    wif,
  );

  return {
    address,
    encryptedPrivateKey,
  };
}