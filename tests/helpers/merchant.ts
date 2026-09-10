import type { Db, ObjectId } from "mongodb";

import { USERS_COLLECTION } from "../../src/accounts/user.model.js";
import {
  createMerchantAccount,
  findUserByNumber,
} from "../../src/accounts/user.repository.js";
import { SESSIONS_COLLECTION } from "../../src/sessions/session.model.js";

export interface TestMerchant {
  /** The `_id` the session layer keys on. Never leaves the server. */
  accountId: ObjectId;
  /** The public UUID handed back by the register route. */
  userId: string;
  accountNumber: string;
  recoveryPhrase: string;
}

/**
 * Registers a merchant through the real repository, so a fixture cannot drift
 * away from what registration actually writes.
 *
 * Push the returned `accountId` onto a list the suite cleans up in `after`.
 */
export async function createTestMerchant(): Promise<TestMerchant> {
  const created = await createMerchantAccount();
  const user = await findUserByNumber(created.accountNumber);

  if (!user) {
    throw new Error("the merchant was created but could not be read back");
  }

  return { ...created, accountId: user._id };
}

/** Removes the merchants a suite created, along with their sessions. */
export async function deleteTestMerchants(
  database: Db,
  accountIds: ObjectId[],
): Promise<void> {
  if (accountIds.length === 0) {
    return;
  }

  await database
    .collection(SESSIONS_COLLECTION)
    .deleteMany({ accountId: { $in: accountIds } });
  await database
    .collection(USERS_COLLECTION)
    .deleteMany({ _id: { $in: accountIds } });
}
