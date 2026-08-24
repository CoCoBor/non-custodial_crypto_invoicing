import { ObjectId } from "mongodb";
import { SealedSecret } from "../security/secret-envelope.js";

export const ACCOUNTS_COLLECTION = "accounts";

export interface AccountDocument {
  _id: ObjectId;
  accountNumberLookup: string;
  accountNumberCipher: SealedSecret;
  recoveryPublicKey: string;
  totpSecretCipher: SealedSecret | null;
  createdAt: Date;
  updatedAt: Date;
}
