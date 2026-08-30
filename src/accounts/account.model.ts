import { ObjectId } from "mongodb";
import { SealedSecret } from "../security/secret-envelope.js";
import { BitcoinAccountKey } from "../chains/bitcoin/extended-key.js";

export const ACCOUNTS_COLLECTION = "accounts";

export interface AccountDocument {
  _id: ObjectId;
  publicId: string //unique
  accountNumberLookup: string; //unique
  accountNumberCipher: SealedSecret; //unique
  recoveryPublicKey: string;
  totpSecretCipher: SealedSecret | null;
  totpPendingCipher: SealedSecret | null;
  lastUsedTotpStep: number | null;
  bitcoinAccountKey: BitcoinAccountKey | null
  nextBitcoinAddressIndex: number
  createdAt: Date;
  updatedAt: Date;
}
