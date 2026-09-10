import { ObjectId } from "mongodb";
import { generateTotpSecret, verifyTotpCode } from "../security/totp.js";
import { openSecret, sealSecret } from "../security/secret-envelope.js";
import { User } from "./user.model.js";

export async function prepareUserTotp(accountId: ObjectId) {
  const secret = generateTotpSecret();
  const sealed = sealSecret("totp-secret", secret);

  const result = await User.updateOne(
    { _id: accountId, totp_enabled: false },
    { $set: { totp_pending_secret: sealed } },
  );

  if (result.modifiedCount !== 1) {
    return undefined;
  }
  return secret;
}

export async function enableUserTotp(
  accountId: ObjectId,
  code: string,
): Promise<boolean> {
  const user = await User.findById(accountId).select("+totp_pending_secret");

  if (!user || user.totp_enabled || !user.totp_pending_secret) {
    return false;
  }

  const pending = user.totp_pending_secret;
  const sealed = {
    keyVersion: pending.keyVersion,
    initialisationVector: Buffer.from(pending.initialisationVector),
    authenticationTag: Buffer.from(pending.authenticationTag),
    ciphertext: Buffer.from(pending.ciphertext),
  };

  const secret = openSecret("totp-secret", sealed);
  const step = verifyTotpCode(secret, code);

  if (step === undefined) {
    return false;
  }

  const result = await User.updateOne(
    {
      _id: accountId,
      totp_enabled: false,
      "totp_pending_secret.initialisationVector": sealed.initialisationVector,
      "totp_pending_secret.ciphertext": sealed.ciphertext,
    },
    {
      $set: {
        totp_enabled: true,
        totp_secret: sealed,
        totp_pending_secret: null,
        totp_last_used_step: step,
      },
    },
  );

  return result.modifiedCount === 1;
}

export async function verifyUserTotp(
  accountId: ObjectId,
  code: string,
): Promise<boolean> {
  const user = await User.findById(accountId).select("+totp_secret");

  if (!user || !user.totp_enabled || !user.totp_secret) {
    return false;
  }

  const store = user.totp_secret;
  const sealed = {
    keyVersion: store.keyVersion,
    initialisationVector: Buffer.from(store.initialisationVector),
    authenticationTag: Buffer.from(store.authenticationTag),
    ciphertext: Buffer.from(store.ciphertext),
  };

  const secret = openSecret("totp-secret", sealed);
  const step = verifyTotpCode(secret, code);

  if (step === undefined) {
    return false;
  }

  const result = await User.updateOne(
    {
      _id: accountId,
      totp_enabled: true,
      "totp_secret.initialisationVector": sealed.initialisationVector,
      "totp_secret.ciphertext": sealed.ciphertext,
      $or: [
        { totp_last_used_step: null },
        { totp_last_used_step: { $lt: step } },
      ],
    },
    {
      $set: {
        totp_last_used_step: step,
      },
    },
  );

  return result.modifiedCount === 1;
}
