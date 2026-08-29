import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db, ObjectId } from "mongodb";

import { ACCOUNTS_COLLECTION } from "../../src/accounts/account.model.js";
import { createAccount } from "../../src/accounts/account.repository.js";
import { createApp } from "../../src/app.js";
import { deriveReceiveAddress } from "../../src/chains/bitcoin/extended-key.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import {
  INVOICES_COLLECTION,
  type InvoiceDocument,
} from "../../src/invoices/invoice.model.js";
import { SESSIONS_COLLECTION } from "../../src/sessions/session.model.js";

const COOKIE_NAME = "session";

const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

const BIP84_ADDRESS_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const BIP84_ADDRESS_1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";

const DUST_LIMIT_SATOSHI = 546;

let database: Db;
let server: Server;
let baseUrl: string;

const createdAccountIds: ObjectId[] = [];

interface InvoiceBody {
  data?: {
    invoiceId: string;
    status: string;
    address: string;
    amountSatoshi: number;
    paymentUri: string;
    expiresAt: string;
    underpaidTolerancePercent: number;
  };
  error?: { code: string; message: string };
}

async function signedInAccount(withKey = true) {
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
  const token = decodeURIComponent(
    cookie.split(";")[0]!.slice(COOKIE_NAME.length + 1),
  );

  if (withKey) {
    await fetch(`${baseUrl}/settlement/bitcoin`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `${COOKIE_NAME}=${token}` },
      body: JSON.stringify({ extendedPublicKey: ZPUB }),
    });
  }

  return { accountId: account.accountId, token };
}

async function createInvoice(token: string | undefined, body: unknown) {
  const response = await fetch(`${baseUrl}/invoices`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `${COOKIE_NAME}=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as InvoiceBody };
}

function invoices() {
  return database.collection<InvoiceDocument>(INVOICES_COLLECTION);
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
    await invoices().deleteMany({ accountId: { $in: createdAccountIds } });
    await database
      .collection(SESSIONS_COLLECTION)
      .deleteMany({ accountId: { $in: createdAccountIds } });
    await database
      .collection(ACCOUNTS_COLLECTION)
      .deleteMany({ _id: { $in: createdAccountIds } });
  }

  server.close();
  await once(server, "close");
  await disconnectFromMongoDB();
});

describe("POST /invoices access and validation", () => {
  it("requires an active session", async () => {
    assert.equal((await createInvoice(undefined, { amountSatoshi: 500_000 })).status, 401);
  });

  it("refuses when the merchant has no bitcoin key configured", async () => {
    const { token } = await signedInAccount(false);
    const response = await createInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, "SETTLEMENT_NOT_CONFIGURED");
  });

  it("rejects a missing or non numeric amount", async () => {
    const { token } = await signedInAccount();

    assert.equal((await createInvoice(token, {})).status, 400);
    assert.equal((await createInvoice(token, { amountSatoshi: "500000" })).status, 400);
  });

  it("rejects an amount that is not a whole number of satoshi", async () => {
    const { token } = await signedInAccount();
    const response = await createInvoice(token, { amountSatoshi: 500_000.5 });

    assert.equal(
      response.status,
      400,
      "satoshi is the smallest unit — a fraction of one cannot be paid",
    );
  });

  it("rejects zero, negative, and absurd amounts", async () => {
    const { token } = await signedInAccount();

    for (const amountSatoshi of [0, -1, 2_100_000_000_000_001]) {
      assert.equal((await createInvoice(token, { amountSatoshi })).status, 400);
    }
  });

  it("rejects an amount below the dust limit", async () => {
    const { token } = await signedInAccount();
    const response = await createInvoice(token, {
      amountSatoshi: DUST_LIMIT_SATOSHI - 1,
    });

    assert.equal(
      response.status,
      400,
      "an output below the dust limit costs more to spend than it is worth",
    );
  });

  it("rejects a lifetime outside one to sixty minutes", async () => {
    const { token } = await signedInAccount();

    for (const lifetimeMinutes of [0, 61, 1.5, -5]) {
      assert.equal(
        (await createInvoice(token, { amountSatoshi: 500_000, lifetimeMinutes })).status,
        400,
      );
    }
  });

  it("rejects an underpayment tolerance outside zero to one hundred", async () => {
    const { token } = await signedInAccount();

    for (const underpaidTolerancePercent of [-1, 101]) {
      assert.equal(
        (await createInvoice(token, { amountSatoshi: 500_000, underpaidTolerancePercent }))
          .status,
        400,
      );
    }
  });
});

describe("POST /invoices success", () => {
  it("responds 201 with a waiting invoice", async () => {
    const { token } = await signedInAccount();
    const response = await createInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(response.status, 201);
    assert.equal(response.body.data?.status, "waiting");
  });

  it("hands the payer the merchant's first derived address", async () => {
    const { token } = await signedInAccount();
    const response = await createInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(response.body.data?.address, BIP84_ADDRESS_0);
  });

  it("gives every invoice its own address", async () => {
    const { token } = await signedInAccount();

    const first = await createInvoice(token, { amountSatoshi: 500_000 });
    const second = await createInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(first.body.data?.address, BIP84_ADDRESS_0);
    assert.equal(second.body.data?.address, BIP84_ADDRESS_1);
  });

  it("returns a public invoice id, not a database id", async () => {
    const { token } = await signedInAccount();
    const { body } = await createInvoice(token, { amountSatoshi: 500_000 });

    assert.match(String(body.data?.invoiceId), /^inv_[A-Z2-7]+$/);
  });

  it("builds a BIP-21 payment uri for the QR code", async () => {
    const { token } = await signedInAccount();
    const { body } = await createInvoice(token, { amountSatoshi: 500_000 });

    const uri = new URL(String(body.data?.paymentUri));

    assert.equal(uri.protocol, "bitcoin:");
    assert.equal(uri.pathname, BIP84_ADDRESS_0);
    assert.equal(
      uri.searchParams.get("amount"),
      "0.005",
      "BIP-21 amounts are denominated in BTC, not satoshi",
    );
  });

  it("expires thirty minutes out by default", async () => {
    const { token } = await signedInAccount();
    const { body } = await createInvoice(token, { amountSatoshi: 500_000 });

    const minutes = (Date.parse(String(body.data?.expiresAt)) - Date.now()) / 60_000;

    assert.ok(minutes > 29 && minutes <= 30, `expiry was ${minutes} minutes out`);
  });

  it("honours a requested lifetime", async () => {
    const { token } = await signedInAccount();
    const { body } = await createInvoice(token, {
      amountSatoshi: 500_000,
      lifetimeMinutes: 5,
    });

    const minutes = (Date.parse(String(body.data?.expiresAt)) - Date.now()) / 60_000;

    assert.ok(minutes > 4 && minutes <= 5, `expiry was ${minutes} minutes out`);
  });

  it("defaults the underpayment tolerance to zero", async () => {
    const { token } = await signedInAccount();
    const { body } = await createInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(body.data?.underpaidTolerancePercent, 0);
  });
});

describe("the stored invoice", () => {
  async function storedInvoice(token: string, body: unknown) {
    const response = await createInvoice(token, body);
    const stored = await invoices().findOne({
      publicId: String(response.body.data?.invoiceId),
    });

    assert.ok(stored, "the invoice was returned but never stored");

    return stored;
  }

  it("snapshots the address, so rotating the merchant key cannot move it", async () => {
    const { token } = await signedInAccount();
    const stored = await storedInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(stored.address, BIP84_ADDRESS_0);
    assert.equal(stored.addressIndex, 0);
  });

  it("keeps the amount as an integer number of satoshi", async () => {
    const { token } = await signedInAccount();
    const stored = await storedInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(stored.amountSatoshi, 500_000);
    assert.ok(Number.isInteger(stored.amountSatoshi));
  });

  it("starts with nothing paid", async () => {
    const { token } = await signedInAccount();
    const stored = await storedInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(stored.paidSatoshi, 0);
    assert.equal(stored.status, "waiting");
  });

  it("snapshots the tolerance rather than reading it live later", async () => {
    const { token } = await signedInAccount();
    const stored = await storedInvoice(token, {
      amountSatoshi: 500_000,
      underpaidTolerancePercent: 5,
    });

    assert.equal(
      stored.underpaidTolerancePercent,
      5,
      "changing a merchant setting must never alter an invoice already in flight",
    );
  });

  it("records when it was created and when it started waiting", async () => {
    const { token } = await signedInAccount();
    const stored = await storedInvoice(token, { amountSatoshi: 500_000 });

    assert.ok(stored.timestamps.created instanceof Date);
    assert.ok(stored.timestamps.waiting instanceof Date);
    assert.equal(stored.timestamps.confirmed, null);
    assert.equal(stored.timestamps.expired, null);
  });

  it("belongs to the merchant that created it", async () => {
    const { token, accountId } = await signedInAccount();
    const stored = await storedInvoice(token, { amountSatoshi: 500_000 });

    assert.equal(String(stored.accountId), String(accountId));
  });

  it("derives back to the same address from the stored index", async () => {
    const { token, accountId } = await signedInAccount();
    const stored = await storedInvoice(token, { amountSatoshi: 500_000 });

    const account = await database
      .collection(ACCOUNTS_COLLECTION)
      .findOne({ _id: accountId });

    assert.equal(
      deriveReceiveAddress(account!.bitcoinAccountKey, stored.addressIndex),
      stored.address,
    );
  });
});

describe("invoice indexes", () => {
  it("makes the public id unique", async () => {
    const indexes = await invoices().listIndexes().toArray();
    const publicIdIndex = indexes.find((index) => index.key.publicId === 1);

    assert.ok(publicIdIndex, "no index on publicId");
    assert.equal(publicIdIndex.unique, true);
  });

  it("indexes the address, because the watcher looks invoices up by it", async () => {
    const indexes = await invoices().listIndexes().toArray();

    assert.ok(
      indexes.some((index) => index.key.address === 1),
      "no index on address",
    );
  });
});
