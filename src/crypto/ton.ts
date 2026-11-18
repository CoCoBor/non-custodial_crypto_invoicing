import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";
import { SealedSecret, sealSecret } from "../security/secret-envelope.js";
import { formatSealedSecretForEnv } from "./sol.js";

// A fresh deposit address for one TON invoice.
//
// The key is a 24-word TON mnemonic (TON's own word scheme, not BIP39).
// Tonkeeper and MyTonWallet import it and show the same W5 wallet, so stuck
// funds can be moved by hand if the payout code fails.
//
// The wallet is a W5 (v5r1) contract on workchain 0. It does not exist on
// chain yet: the first payout deploys it (see transactions/ton.ts).
export async function generateTonAddress(): Promise<{
  address: string;
  encryptedPrivateKey: SealedSecret;
}> {
  const words = await mnemonicNew(24);
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  keyPair.secretKey.fill(0);

  // Non-bounceable form (UQ…). Until the first payout this wallet has no
  // code, and wallets send a "bounceable" payment to such an address
  // straight back to the payer.
  const address = wallet.address.toString({
    urlSafe: true,
    bounceable: false,
    testOnly: false,
  });

  return {
    address,
    encryptedPrivateKey: sealSecret("ton-deposit-key", words.join(" ")),
  };
}

// The TON gas wallet for jetton payouts: a W5 wallet from a 24-word
// mnemonic, like a deposit, so Tonkeeper can open it too. Returns its
// address and the sealed mnemonic in .env form; the words are never printed.
export async function generateTonGasWallet(): Promise<{
  address: string;
  sealedKeyForEnv: string;
}> {
  const words = await mnemonicNew(24);
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
  keyPair.secretKey.fill(0);
  return {
    address: wallet.address.toString({ urlSafe: true, bounceable: false, testOnly: false }),
    sealedKeyForEnv: formatSealedSecretForEnv(sealSecret("ton-gas-wallet-key", words.join(" "))),
  };
}
