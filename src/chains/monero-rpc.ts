import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

// JSON-RPC client for monero-wallet-rpc (and monerod, which speaks the same
// envelope on /json_rpc). No env import: tests build clients for local nodes.
//
// With --rpc-login, monero-wallet-rpc asks for HTTP digest auth (RFC 7616 /
// 2617, qop "auth"), which fetch does not do, so it is done here: the first
// call gets a 401 with the challenge, later calls reuse it with a rising
// nonce count until the server issues a new nonce.

export type MoneroRpcError = { code: number; message: string };

/** `result` or the node's JSON-RPC error. */
export type MoneroRpcAnswer = { result: unknown } | { error: MoneroRpcError };

export type MoneroRpc = {
  /** undefined: no usable reply (network, HTTP status, auth, or not JSON-RPC). Already logged. */
  call: (method: string, params?: Record<string, unknown>) => Promise<MoneroRpcAnswer | undefined>;
};

export type DigestChallenge = {
  realm: string;
  nonce: string;
  qop?: string;
  algorithm?: string;
  opaque?: string;
};

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

/** The Authorization header for one request (MD5 or MD5-sess, qop "auth"). */
export function digestAuthorization(input: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  nc: number;
  cnonce: string;
}): string {
  const { username, password, method, uri, challenge, cnonce } = input;
  const nc = input.nc.toString(16).padStart(8, "0");
  const algorithm = challenge.algorithm ?? "MD5";
  let ha1 = md5(`${username}:${challenge.realm}:${password}`);
  if (algorithm.toUpperCase() === "MD5-SESS") ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return (
    `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", ` +
    `algorithm=${algorithm}, qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"` +
    (challenge.opaque === undefined ? "" : `, opaque="${challenge.opaque}"`)
  );
}

/** The challenge to answer from a WWW-Authenticate value; MD5 preferred over MD5-sess. */
function pickChallenge(header: string | null): DigestChallenge | undefined {
  if (!header) return undefined;
  const challenges = header
    .split(/(?:^|,)\s*Digest\s+/i)
    .filter((part) => part.trim() !== "")
    .map((part) => {
      const fields: Record<string, string> = {};
      for (const match of part.matchAll(/([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) {
        fields[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
      }
      return fields;
    })
    .filter((fields) => fields.realm !== undefined && fields.nonce !== undefined)
    .filter((fields) => fields.qop === undefined || fields.qop.split(",").map((q) => q.trim()).includes("auth"))
    .filter((fields) => ["MD5", "MD5-SESS"].includes((fields.algorithm ?? "MD5").toUpperCase()));
  const chosen = challenges.find((c) => (c.algorithm ?? "MD5").toUpperCase() === "MD5") ?? challenges[0];
  if (chosen === undefined) return undefined;
  return {
    realm: chosen.realm!,
    nonce: chosen.nonce!,
    ...(chosen.qop !== undefined && { qop: chosen.qop }),
    ...(chosen.algorithm !== undefined && { algorithm: chosen.algorithm }),
    ...(chosen.opaque !== undefined && { opaque: chosen.opaque }),
  };
}

const replySchema = z.union([
  z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
  z.object({ result: z.unknown().refine((value) => value !== undefined) }),
]);

export function createMoneroRpc(options: {
  /** e.g. http://127.0.0.1:18083/json_rpc */
  url: string;
  login?: { username: string; password: string };
  /** Names the node in log lines. */
  label?: string;
  timeoutMs?: number;
}): MoneroRpc {
  const { url, login } = options;
  const label = options.label ?? "Monero RPC";
  const uri = new URL(url).pathname;
  let challenge: DigestChallenge | undefined;
  let nc = 0;
  // One request at a time: the digest nonce count must rise in the order the
  // server sees the requests, and the wallet serves one call at a time anyway.
  let queue: Promise<unknown> = Promise.resolve();

  async function post(body: string): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (login && challenge) {
      nc += 1;
      headers.authorization = digestAuthorization({
        ...login,
        method: "POST",
        uri,
        challenge,
        nc,
        cnonce: randomBytes(8).toString("hex"),
      });
    }
    return await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      redirect: "error",
    });
  }

  async function callNow(method: string, params: Record<string, unknown>): Promise<MoneroRpcAnswer | undefined> {
    // Params can hold signed transactions and tx keys: never logged.
    const body = JSON.stringify({ jsonrpc: "2.0", id: "0", method, params });
    try {
      let res = await post(body);
      if (res.status === 401 && login) {
        await res.arrayBuffer();
        challenge = pickChallenge(res.headers.get("www-authenticate"));
        nc = 0;
        if (challenge === undefined) {
          console.warn(`${label}: 401 without a usable digest challenge:`, method);
          return undefined;
        }
        res = await post(body);
      }
      if (!res.ok) {
        console.warn(`${label} HTTP failed:`, method, res.status);
        return undefined;
      }
      const parsed = replySchema.safeParse(await res.json());
      if (!parsed.success) {
        console.warn(`${label}: not a JSON-RPC reply:`, method);
        return undefined;
      }
      return "error" in parsed.data ? { error: parsed.data.error } : { result: parsed.data.result };
    } catch (error) {
      console.warn(`${label} request failed:`, method, error instanceof Error ? error.message : "unknown error");
      return undefined;
    }
  }

  return {
    call(method, params = {}) {
      const next = queue.then(() => callNow(method, params));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
