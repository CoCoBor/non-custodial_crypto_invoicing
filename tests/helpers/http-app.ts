import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Db } from "mongodb";

import { createApp } from "../../src/app.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";

/** The app on a random local port, against the test database. */
export async function startTestApp(): Promise<{
  baseUrl: string;
  db: Db;
  stop: () => Promise<void>;
}> {
  const db = await connectToMongoDb();
  const server: Server = createApp().listen(0);
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

/** Logs in with the account number alone (no TOTP set) and returns the session cookie. */
export async function logIn(baseUrl: string, accountNumber: string): Promise<string> {
  const response = await postJson(`${baseUrl}/auth/login`, { accountNumber });
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  if (response.status !== 200 || !cookie) throw new Error(`login failed: ${response.status}`);
  return cookie;
}
