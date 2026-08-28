import { ObjectId } from "mongodb";
import { SealedSecret } from "../security/secret-envelope.js";

export const ACCOUNTS_COLLECTION = "accounts";

export interface AccountDocument {
  _id: ObjectId;
  publicId: string
  accountNumberLookup: string;
  accountNumberCipher: SealedSecret;
  recoveryPublicKey: string;
  totpSecretCipher: SealedSecret | null;
  totpPendingCipher: SealedSecret | null;
  lastUsedTotpStep: number | null;
  createdAt: Date;
  updatedAt: Date;
}
