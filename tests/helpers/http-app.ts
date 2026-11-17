import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Db } from "mongodb";

import { createApp, type AppDeps } from "../../src/app.js";
import { generateTotpCode } from "../../src/auth/totp.function.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { signChallenge } from "./recovery-signer.js";

/** The app on a random local port, against the test database. */
export async function startTestApp(deps?: Partial<AppDeps>): Promise<{
  baseUrl: string;
  db: Db;
  stop: () => Promise<void>;
}> {
  const db = await connectToMongoDb();
  const server: Server = createApp(deps).listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    db,
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await disconnectFromMongoDB();
    },
  };
}

export async function postJson(
  url: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

/** A new merchant: what registration returned. */
export async function registerMerchant(baseUrl: string) {
  const response = await postJson(`${baseUrl}/auth/register`);
  if (response.status !== 201) throw new Error(`register failed: ${response.status}`);
  return response.body.data as {
    userId: string;
    accountNumber: string;
    accountNumberDisplay: string;
    recoveryPhrase: string;
  };
}

/**
 * A merchant's first login, done the only way it now works: sign a challenge
 * with the 12 words, set up TOTP with one code, get the full session.
 */
export async function logIn(
  baseUrl: string,
  merchant: { accountNumber: string; recoveryPhrase: string },
): Promise<{ cookie: string; totpSecret: string }> {
  const cookieOf = (headers: Headers) => headers.getSetCookie()[0]?.split(";")[0];

  const challenge = (await postJson(`${baseUrl}/auth/challenge`, {
    accountNumber: merchant.accountNumber,
  })).body.data.challenge;
  const first = await postJson(`${baseUrl}/auth/login/recovery`, {
    accountNumber: merchant.accountNumber,
    challenge,
    signature: signChallenge(merchant.recoveryPhrase, challenge),
  });
  const setupCookie = cookieOf(first.headers);
  if (first.status !== 200 || !setupCookie) throw new Error(`first login failed: ${first.status}`);

  const totpSecret: string = (await postJson(`${baseUrl}/auth/2fa/setup`, {}, { cookie: setupCookie })).body.data.secret;
  const enable = await postJson(
    `${baseUrl}/auth/2fa/enable`,
    { code: generateTotpCode(totpSecret) },
    { cookie: setupCookie },
  );
  const cookie = cookieOf(enable.headers);
  if (enable.status !== 200 || !cookie) throw new Error(`TOTP setup failed: ${enable.status}`);

  return { cookie, totpSecret };
}
