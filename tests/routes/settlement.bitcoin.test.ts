import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db, ObjectId } from "mongodb";

import {
  ACCOUNTS_COLLECTION,
  type AccountDocument,
} from "../../src/accounts/account.model.js";
import { createAccount } from "../../src/accounts/account.repository.js";
import { createApp } from "../../src/app.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { SESSIONS_COLLECTION } from "../../src/sessions/session.model.js";

const COOKIE_NAME = "session";

// Real mainnet addresses, one of each type a merchant might hold.
const P2PKH = "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA";
const P2SH = "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf";
const P2WPKH = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const P2TR =
  "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";

const TESTNET = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

let database: Db;
let server: Server;
let baseUrl: string;

const createdAccountIds: ObjectId[] = [];

async function signedInAccount() {
  const account = await createAccount(database);
  createdAccountIds.push(account.accountId);

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountNumber: account.accountNumber }),
  });

  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${COOKIE_NAME}=`))!;

  return {
    accountId: account.accountId,
    token: decodeURIComponent(
      cookie.split(";")[0]!.slice(COOKIE_NAME.length + 1),
    ),
  };
}

async function setPayoutAddress(token: string | undefined, body: unknown) {
  const response = await fetch(`${baseUrl}/settlement/bitcoin`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `${COOKIE_NAME}=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as {
      data?: { payoutAddress?: string; addressType?: string };
      error?: { code: string; message: string };
    },
  };
}

function accounts() {
  return database.collection<AccountDocument>(ACCOUNTS_COLLECTION);
}

async function storedAddress(accountId: ObjectId) {
  const account = await accounts().findOne({ _id: accountId });

  return account?.bitcoinPayoutAddress ?? null;
}

before(async () => {
  database = await connectToMongoDb();
  await ensureIndexes(database);

  server = createApp().listen(0);
  await once(server, "listening");

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (createdAccountIds.length > 0) {
    await database
      .collection(SESSIONS_COLLECTION)
      .deleteMany({ accountId: { $in: createdAccountIds } });
    await accounts().deleteMany({ _id: { $in: createdAccountIds } });
  }

  server.close();
  await once(server, "close");
  await disconnectFromMongoDB();
});

describe("PUT /settlement/bitcoin", () => {
  it("requires an active session", async () => {
    const response = await setPayoutAddress(undefined, {
      payoutAddress: P2WPKH,
    });

    assert.equal(response.status, 401);
  });

  it("rejects a malformed body", async () => {
    const { token } = await signedInAccount();

    assert.equal((await setPayoutAddress(token, {})).status, 400);
    assert.equal(
      (await setPayoutAddress(token, { payoutAddress: 123 })).status,
      400,
    );
  });

  it("separates a bad body shape from a bad address", async () => {
    const { token } = await signedInAccount();

    const badShape = await setPayoutAddress(token, {});
    const badAddress = await setPayoutAddress(token, {
      payoutAddress: "not-an-address",
    });

    assert.equal(badShape.body.error?.code, "INVALID_REQUEST");
    assert.equal(
      badAddress.body.error?.code,
      "INVALID_ADDRESS",
      "a merchant fixing their own address is entitled to know which was wrong",
    );
  });

  it("accepts every mainnet address type and reports which it is", async () => {
    for (const [address, type] of [
      [P2PKH, "p2pkh"],
      [P2SH, "p2sh"],
      [P2WPKH, "p2wpkh"],
      [P2TR, "p2tr"],
    ]) {
      const { token } = await signedInAccount();
      const response = await setPayoutAddress(token, { payoutAddress: address });

      assert.equal(response.status, 200, `${type} was rejected`);
      assert.equal(response.body.data?.payoutAddress, address);
      assert.equal(response.body.data?.addressType, type);
    }
  });

  it("stores the address on the account, because settlement reads it later", async () => {
    const { token, accountId } = await signedInAccount();
    await setPayoutAddress(token, { payoutAddress: P2WPKH });

    assert.equal(await storedAddress(accountId), P2WPKH);
  });

  it("replaces a previously registered address", async () => {
    const { token, accountId } = await signedInAccount();

    await setPayoutAddress(token, { payoutAddress: P2WPKH });
    await setPayoutAddress(token, { payoutAddress: P2TR });

    assert.equal(
      await storedAddress(accountId),
      P2TR,
      "a merchant changing wallets must not be stuck with the old address",
    );
  });

  it("stores one spelling of a bech32 address, whatever case was pasted", async () => {
    const { token, accountId } = await signedInAccount();
    const response = await setPayoutAddress(token, {
      payoutAddress: P2WPKH.toUpperCase(),
    });

    assert.equal(response.status, 200);
    assert.equal(
      await storedAddress(accountId),
      P2WPKH,
      "uppercase bech32 is the same address; storing both spellings breaks comparison",
    );
  });

  it("tolerates whitespace from a copy and paste", async () => {
    const { token, accountId } = await signedInAccount();
    await setPayoutAddress(token, { payoutAddress: `  ${P2PKH}\n` });

    assert.equal(await storedAddress(accountId), P2PKH);
  });

  // ── the two mistakes that would lose money ─────────────────────────────
  it("refuses an address from another network, which cannot receive mainnet funds", async () => {
    const { token, accountId } = await signedInAccount();
    const response = await setPayoutAddress(token, { payoutAddress: TESTNET });

    assert.equal(response.status, 400);
    assert.equal(response.body.error?.code, "INVALID_ADDRESS");
    assert.equal(
      await storedAddress(accountId),
      null,
      "a rejected address must not be stored",
    );
  });

  it("refuses an extended public key, which is not an address", async () => {
    // The previous design took a zpub here. A merchant following old
    // instructions must be told, not silently given a broken account.
    const { token, accountId } = await signedInAccount();
    const response = await setPayoutAddress(token, { payoutAddress: ZPUB });

    assert.equal(response.status, 400);
    assert.equal(await storedAddress(accountId), null);
  });

  it("leaves the account unchanged when the address is rejected", async () => {
    const { token, accountId } = await signedInAccount();

    await setPayoutAddress(token, { payoutAddress: P2WPKH });
    await setPayoutAddress(token, { payoutAddress: "garbage" });

    assert.equal(
      await storedAddress(accountId),
      P2WPKH,
      "a failed update must not clear a working address",
    );
  });
});
