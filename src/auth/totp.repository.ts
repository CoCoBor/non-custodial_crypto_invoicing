import * as totpFunc from "../auth/totp.function.js";
import { openSecret, sealSecret } from "../security/secret-envelope.js";
import { User } from "../database/users.model.js";

export async function prepareUserTotp(
  user_id: string,
): Promise<string | undefined> {
  const secret = totpFunc.generateTotpSecret();
  const sealed = sealSecret("totp-secret", secret);
  const result = await User.updateOne(
    { user_id },
    { $set: { totp_pending_secret: sealed } },
  );

  if (result.modifiedCount !== 1) return undefined;
  return secret;
}

export async function enableUserTotp(
  user_id: string,
  code: string,
): Promise<boolean> {
  const user = await User.findOne({ user_id }).select("+totp_pending_secret");
  if (!user || user.totp_enabled || !user.totp_pending_secret) {
    return false;
  }

  const { keyVersion, initialisationVector, authenticationTag, ciphertext } =
    user.totp_pending_secret;

  const sealed = {
    keyVersion,
    initialisationVector,
    authenticationTag,
    ciphertext,
  };

  const secret = openSecret("totp-secret", sealed);
  const step = totpFunc.verifyTotpCode(secret, code);

  if (!step) return false;

  const result = await User.updateOne(
    {
      user_id,
      totp_enabled: false,
      "totp_pending_secret.initialisationVector": sealed.initialisationVector,
      "totp_pending_secret.ciphertext": sealed.ciphertext,
    },
    {
      $set: {
        totp_secret: sealed,
        totp_enabled: true,
        totp_pending_secret: null,
        totp_last_used_step: step,
      },
    },
  );

  return result.modifiedCount === 1;
}

export async function verifyUserTptp(
  user_id: string,
  code: string,
): Promise<boolean> {
  const user = await User.findOne({ user_id }).select("+totp_secret");

  if (!user || !user.totp_enabled || !user.totp_secret) return false;

  const { keyVersion, initialisationVector, authenticationTag, ciphertext } =
    user.totp_secret;

  const sealed = {
    keyVersion,
    initialisationVector,
    authenticationTag,
    ciphertext,
  };

  const secret = openSecret("totp-secret", sealed);
  const step = totpFunc.verifyTotpCode(secret, code);

  if (!step) return false;

  const result = await User.updateOne(
    {
      user_id,
      totp_enabled: true,
      "totp_secret.initialisationVector": sealed.initialisationVector,
      "totp_secret.ciphertext": sealed.ciphertext,
      $or: [
        { totp_last_used_step: { $lt: step } },
        { totp_last_used_step: null },
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

/**
 * Finishes replacing the authenticator: the code must come from the new
 * secret prepared by prepareUserTotp. The old secret stops working.
 */
export async function replaceUserTotp(
  user_id: string,
  code: string,
): Promise<boolean> {
  const user = await User.findOne({ user_id }).select("+totp_pending_secret");
  if (!user || !user.totp_enabled || !user.totp_pending_secret) {
    return false;
  }

  const { keyVersion, initialisationVector, authenticationTag, ciphertext } =
    user.totp_pending_secret;
  const sealed = { keyVersion, initialisationVector, authenticationTag, ciphertext };

  const step = totpFunc.verifyTotpCode(openSecret("totp-secret", sealed), code);
  if (!step) return false;

  const result = await User.updateOne(
    {
      user_id,
      totp_enabled: true,
      "totp_pending_secret.initialisationVector": sealed.initialisationVector,
      "totp_pending_secret.ciphertext": sealed.ciphertext,
    },
    {
      $set: {
        totp_secret: sealed,
        totp_pending_secret: null,
        totp_last_used_step: step,
      },
    },
  );

  return result.modifiedCount === 1;
}
