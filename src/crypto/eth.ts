import { Wallet } from "ethers";
import { SealedSecret, sealSecret } from "../security/secret-envelope.js";

export function generateEthAddress(): {
  address: string;
  encryptedPrivateKey: SealedSecret;
} {
  const wallet = Wallet.createRandom();

  return {
    address: wallet.address,
    encryptedPrivateKey: sealSecret("ethereum-deposit-key", wallet.privateKey),
  };
}
