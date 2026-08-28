import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { Db, ObjectId } from "mongodb";

import { ACCOUNTS_COLLECTION } from "../../src/accounts/account.model.js";
import { createAccount } from "../../src/accounts/account.repository.js";
import { createApp } from "../../src/app.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { ensureIndexes } from "../../src/infrastructure/database/indexes.js";
import { generateTotpCode } from "../../src/security/totp.js";
import { SESSIONS_COLLECTION } from "../../src/sessions/session.model.js";

const COOKIE_NAME = "session";

let database: Db;
let server: Server;
let baseUrl: string;

const createdAccountIds: ObjectId[] = [];

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function tokenFrom(headers: Headers): string | undefined {
  const cookie = headers
    .getSetCookie()
    .find((value) => value.startsWith(`${COOKIE_NAME}=`));
  const raw = cookie?.split(";")[0]?.slice(COOKIE_NAME.length + 1);

  return raw ? decodeURIComponent(raw) : undefined;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.token ? { cookie: `${COOKIE_NAME}=${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Envelope,
  };
}

/** Registers an account and logs in, returning an active session token. */
async function signedInAccount() {
  const account = await createAccount(database);
  createdAccountIds.push(account.accountId);

  const login = await call("POST", "/auth/login", {
    body: { accountNumber: account.accountNumber },
  });

  return {
    accountNumber: account.accountNumber,
    accountId: account.accountId,
    token: tokenFrom(login.headers)!,
  };
}

/**
 * A code from the *next* time window.
 *
 * Enrolment consumes a step, and replay protection then refuses that step
 * forever. A test that enables 2FA and logs in milliseconds later would
 * otherwise reuse the same code, and be correctly rejected.
 */
function loginCode(secret: string): string {
  return generateTotpCode(secret, new Date(Date.now() + 30_000));
}

/** Takes an account all the way through enrolment; returns its secret. */
async function withTwoFactorEnabled() {
  const account = await signedInAccount();

  const setup = await call("POST", "/auth/2fa/setup", { token: account.token });
  const secret = String(setup.body.data?.secret);

  await call("POST", "/auth/2fa/enable", {
    token: account.token,
    body: { code: generateTotpCode(secret) },
  });

  return { ...account, secret };
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
    await database
      .collection(ACCOUNTS_COLLECTION)
      .deleteMany({ _id: { $in: createdAccountIds } });
  }

  server.close();
  await once(server, "close");
  await disconnectFromMongoDB();
});

describe("POST /auth/2fa/setup", () => {
  it("requires an active session", async () => {
    assert.equal((await call("POST", "/auth/2fa/setup")).status, 401);
  });

  it("returns a base32 secret and an otpauth uri", async () => {
    const { token } = await signedInAccount();
    const { status, body } = await call("POST", "/auth/2fa/setup", { token });

    assert.equal(status, 200);
    assert.match(String(body.data?.secret), /^[A-Z2-7]+=*$/);
    assert.ok(String(body.data?.uri).startsWith("otpauth://totp/"));
  });

  it("puts the same secret in the uri that it returns", async () => {
    const { token } = await signedInAccount();
    const { body } = await call("POST", "/auth/2fa/setup", { token });

    const uriSecret = new URL(String(body.data?.uri)).searchParams.get("secret");
    assert.equal(uriSecret, body.data?.secret);
  });

  it("does not switch two factor authentication on yet", async () => {
    const account = await signedInAccount();
    await call("POST", "/auth/2fa/setup", { token: account.token });

    const login = await call("POST", "/auth/login", {
      body: { accountNumber: account.accountNumber },
    });

    assert.equal(
      login.body.data?.requiresTwoFactor,
      false,
      "setup alone must never lock the user out",
    );
  });

  it("replaces the pending secret when called twice", async () => {
    const { token } = await signedInAccount();

    const first = await call("POST", "/auth/2fa/setup", { token });
    const second = await call("POST", "/auth/2fa/setup", { token });

    assert.notEqual(first.body.data?.secret, second.body.data?.secret);

    const enable = await call("POST", "/auth/2fa/enable", {
      token,
      body: { code: generateTotpCode(String(second.body.data?.secret)) },
    });

    assert.equal(enable.status, 200, "the newest secret must be the live one");
  });

  it("refuses once two factor authentication is already on", async () => {
    const { token } = await withTwoFactorEnabled();

    assert.equal((await call("POST", "/auth/2fa/setup", { token })).status, 409);
  });
});

describe("POST /auth/2fa/enable", () => {
  it("requires an active session", async () => {
    assert.equal((await call("POST", "/auth/2fa/enable")).status, 401);
  });

  it("refuses when no setup has been started", async () => {
    const { token } = await signedInAccount();
    const response = await call("POST", "/auth/2fa/enable", {
      token,
      body: { code: "123456" },
    });

    assert.equal(response.status, 409);
  });

  it("rejects a malformed body", async () => {
    const { token } = await signedInAccount();
    await call("POST", "/auth/2fa/setup", { token });

    assert.equal(
      (await call("POST", "/auth/2fa/enable", { token, body: {} })).status,
      400,
    );
    assert.equal(
      (await call("POST", "/auth/2fa/enable", { token, body: { code: 123456 } }))
        .status,
      400,
    );
  });

  it("rejects a wrong code without enabling anything", async () => {
    const account = await signedInAccount();
    await call("POST", "/auth/2fa/setup", { token: account.token });

    const response = await call("POST", "/auth/2fa/enable", {
      token: account.token,
      body: { code: "000000" },
    });

    assert.equal(response.status, 401);

    const login = await call("POST", "/auth/login", {
      body: { accountNumber: account.accountNumber },
    });
    assert.equal(login.body.data?.requiresTwoFactor, false);
  });

  it("enables two factor authentication when the code is right", async () => {
    const account = await signedInAccount();
    const setup = await call("POST", "/auth/2fa/setup", { token: account.token });

    const response = await call("POST", "/auth/2fa/enable", {
      token: account.token,
      body: { code: generateTotpCode(String(setup.body.data?.secret)) },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data?.twoFactorEnabled, true);
  });

  it("makes the next login ask for a second factor", async () => {
    const account = await withTwoFactorEnabled();

    const login = await call("POST", "/auth/login", {
      body: { accountNumber: account.accountNumber },
    });

    assert.equal(login.body.data?.requiresTwoFactor, true);
  });

  it("reports two factor as enabled on the session route", async () => {
    const { token } = await withTwoFactorEnabled();
    const { body } = await call("GET", "/auth/session", { token });

    assert.equal(body.data?.twoFactorEnabled, true);
  });

  it("refuses a second enable once it is already on", async () => {
    const { token, secret } = await withTwoFactorEnabled();

    const response = await call("POST", "/auth/2fa/enable", {
      token,
      body: { code: generateTotpCode(secret) },
    });

    assert.equal(response.status, 409);
  });
});

describe("POST /auth/2fa/verify", () => {
  /** Logs in an account that has 2FA on, returning its pending session token. */
  async function pendingLogin() {
    const account = await withTwoFactorEnabled();
    const login = await call("POST", "/auth/login", {
      body: { accountNumber: account.accountNumber },
    });

    return { ...account, pendingToken: tokenFrom(login.headers)! };
  }

  it("rejects a request with no session", async () => {
    const response = await call("POST", "/auth/2fa/verify", {
      body: { code: "123456" },
    });

    assert.equal(response.status, 401);
  });

  it("rejects a session that is already active", async () => {
    const { token } = await signedInAccount();
    const response = await call("POST", "/auth/2fa/verify", {
      token,
      body: { code: "123456" },
    });

    assert.equal(
      response.status,
      401,
      "an active session has nothing to verify",
    );
  });

  it("rejects a wrong code", async () => {
    const { pendingToken } = await pendingLogin();
    const response = await call("POST", "/auth/2fa/verify", {
      token: pendingToken,
      body: { code: "000000" },
    });

    assert.equal(response.status, 401);
  });

  it("accepts the right code", async () => {
    const { pendingToken, secret } = await pendingLogin();
    const response = await call("POST", "/auth/2fa/verify", {
      token: pendingToken,
      body: { code: loginCode(secret) },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data?.requiresTwoFactor, false);
  });

  it("issues a brand new token rather than upgrading the old one", async () => {
    const { pendingToken, secret } = await pendingLogin();
    const response = await call("POST", "/auth/2fa/verify", {
      token: pendingToken,
      body: { code: loginCode(secret) },
    });

    const newToken = tokenFrom(response.headers);

    assert.ok(newToken, "verify must set a fresh session cookie");
    assert.notEqual(
      newToken,
      pendingToken,
      "reusing the pending token leaves a session fixation hole",
    );
  });

  it("retires the pending token once it has been used", async () => {
    const { pendingToken, secret } = await pendingLogin();
    await call("POST", "/auth/2fa/verify", {
      token: pendingToken,
      body: { code: loginCode(secret) },
    });

    assert.equal((await call("GET", "/auth/session", { token: pendingToken })).status, 401);
  });

  it("gives a session that works on protected routes", async () => {
    const { pendingToken, secret } = await pendingLogin();
    const response = await call("POST", "/auth/2fa/verify", {
      token: pendingToken,
      body: { code: loginCode(secret) },
    });

    const active = await call("GET", "/auth/session", {
      token: tokenFrom(response.headers)!,
    });

    assert.equal(active.status, 200);
  });
});

describe("replay protection", () => {
  it("refuses to accept the same code a second time", async () => {
    const account = await withTwoFactorEnabled();

    const first = await call("POST", "/auth/login", {
      body: { accountNumber: account.accountNumber },
    });
    const second = await call("POST", "/auth/login", {
      body: { accountNumber: account.accountNumber },
    });

    const code = loginCode(account.secret);

    const accepted = await call("POST", "/auth/2fa/verify", {
      token: tokenFrom(first.headers)!,
      body: { code },
    });
    const replayed = await call("POST", "/auth/2fa/verify", {
      token: tokenFrom(second.headers)!,
      body: { code },
    });

    assert.equal(accepted.status, 200);
    assert.equal(
      replayed.status,
      401,
      "a code that already worked must not work again inside its window",
    );
  });
});
