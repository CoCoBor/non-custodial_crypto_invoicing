import { generateBtcAddress } from "../crypto/btc.js";
import { generateTonAddress } from "../crypto/ton.js";
import type { SealedSecret } from "../security/secret-envelope.js";
import type { WatchedCrypto } from "./invoice.function.js";

/** A fresh deposit address for one invoice, with its key sealed. */
export async function generateDepositAddress(
  coin: WatchedCrypto,
): Promise<{ address: string; encryptedPrivateKey: SealedSecret }> {
  return coin === "btc" ? generateBtcAddress() : await generateTonAddress();
}
