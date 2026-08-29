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
import {
  allocateBitcoinAddressIndex,
  createAccount,
} from "../../src/accounts/account.repository.js";
import { createApp } from "../../src/app.js";
import { deriveReceiveAddress } from "../../src/chains/bitcoin/extended-key.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { SESSIONS_COLLECTION } from "../../src/sessions/session.model.js";

const COOKIE_NAME = "session";

const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const YPUB =
  "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP";
const XPUB =
  "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";
const XPRV =
  "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu";

const BIP84_ADDRESS_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

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
    token: decodeURIComponent(cookie.split(";")[0]!.slice(COOKIE_NAME.length + 1)),
  };
}

async function setKey(token: string | undefined, body: unknown) {
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
      data?: { scriptType?: string; firstAddress?: string };
      error?: { code: string; message: string };
    },
  };
}

function accounts() {
  return database.collection<AccountDocument>(ACCOUNTS_COLLECTION);
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
    assert.equal((await setKey(undefined, { extendedPublicKey: ZPUB })).status, 401);
  });

  it("rejects a malformed body", async () => {
    const { token } = await signedInAccount();

    assert.equal((await setKey(token, {})).status, 400);
    assert.equal((await setKey(token, { extendedPublicKey: 123 })).status, 400);
  });

  it("rejects a key it cannot parse, with its own error code", async () => {
    const { token } = await signedInAccount();
    const response = await setKey(token, { extendedPublicKey: "not-a-key" });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error?.code,
      "INVALID_EXTENDED_KEY",
      "a bad key is a different failure from a bad body shape",
    );
  });

  it("refuses a private extended key", async () => {
    const { token, accountId } = await signedInAccount();
    const response = await setKey(token, { extendedPublicKey: XPRV });

    assert.equal(response.status, 400);

    const stored = await accounts().findOne({ _id: accountId });
    assert.equal(
      stored?.bitcoinAccountKey,
      null,
      "a spending key must never reach the database",
    );
  });

  it("accepts a zpub and reports the script type", async () => {
    const { token } = await signedInAccount();
    const response = await setKey(token, { extendedPublicKey: ZPUB });

    assert.equal(response.status, 200);
    assert.equal(response.body.data?.scriptType, "p2wpkh");
  });

  it("returns the first address so the merchant can check their wallet", async () => {
    const { token } = await signedInAccount();
    const response = await setKey(token, { extendedPublicKey: ZPUB });

    assert.equal(
      response.body.data?.firstAddress,
      BIP84_ADDRESS_0,
      "showing address 0 lets the merchant confirm the key before any money moves",
    );
  });

  it("records the script type each prefix implies", async () => {
    for (const [key, scriptType] of [
      [XPUB, "p2pkh"],
      [YPUB, "p2sh-p2wpkh"],
      [ZPUB, "p2wpkh"],
    ] as const) {
      const { token } = await signedInAccount();
      const response = await setKey(token, { extendedPublicKey: key });

      assert.equal(response.body.data?.scriptType, scriptType);
    }
  });

  it("stores the key in its normalised form", async () => {
    const { token, accountId } = await signedInAccount();
    await setKey(token, { extendedPublicKey: ZPUB });

    const stored = await accounts().findOne({ _id: accountId });

    assert.ok(stored?.bitcoinAccountKey);
    assert.equal(stored.bitcoinAccountKey.scriptType, "p2wpkh");
    assert.ok(
      stored.bitcoinAccountKey.key.startsWith("xpub"),
      "the stored key should be the normalised version, not the raw zpub",
    );
  });

  it("lets a merchant replace a key they set earlier", async () => {
    const { token, accountId } = await signedInAccount();

    await setKey(token, { extendedPublicKey: ZPUB });
    const response = await setKey(token, { extendedPublicKey: XPUB });

    assert.equal(response.status, 200);

    const stored = await accounts().findOne({ _id: accountId });
    assert.equal(stored?.bitcoinAccountKey?.scriptType, "p2pkh");
  });
});

describe("allocateBitcoinAddressIndex", () => {
  async function configuredAccount() {
    const { token, accountId } = await signedInAccount();
    await setKey(token, { extendedPublicKey: ZPUB });

    return accountId;
  }

  it("hands out zero first", async () => {
    assert.equal(await allocateBitcoinAddressIndex(database, await configuredAccount()), 0);
  });

  it("counts upward on each call", async () => {
    const accountId = await configuredAccount();

    for (let expected = 0; expected < 5; expected += 1) {
      assert.equal(await allocateBitcoinAddressIndex(database, accountId), expected);
    }
  });

  it("refuses when the merchant has not configured a key", async () => {
    const { accountId } = await signedInAccount();

    assert.equal(
      await allocateBitcoinAddressIndex(database, accountId),
      undefined,
      "there is nowhere to derive an address from yet",
    );
  });

  it("keeps a separate counter for every account", async () => {
    const first = await configuredAccount();
    const second = await configuredAccount();

    await allocateBitcoinAddressIndex(database, first);
    await allocateBitcoinAddressIndex(database, first);

    assert.equal(
      await allocateBitcoinAddressIndex(database, second),
      0,
      "one merchant's invoices must not advance another merchant's counter",
    );
  });

  it("never issues the same index twice under concurrent load", async () => {
    const accountId = await configuredAccount();
    const ATTEMPTS = 50;

    const issued = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        allocateBitcoinAddressIndex(database, accountId),
      ),
    );

    assert.equal(
      new Set(issued).size,
      ATTEMPTS,
      "two invoices sharing an index would share an address, and a single payment would satisfy both",
    );
    assert.deepEqual(
      [...issued].sort((a, b) => a! - b!),
      Array.from({ length: ATTEMPTS }, (_, i) => i),
      "the allocated indexes should be a contiguous run with no gaps",
    );
  });

  it("produces a distinct address for every index it hands out", async () => {
    const accountId = await configuredAccount();
    const stored = await accounts().findOne({ _id: accountId });
    const accountKey = stored!.bitcoinAccountKey!;

    const addresses = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const index = await allocateBitcoinAddressIndex(database, accountId);
      addresses.add(deriveReceiveAddress(accountKey, index!)!);
    }

    assert.equal(addresses.size, 10);
  });
});
