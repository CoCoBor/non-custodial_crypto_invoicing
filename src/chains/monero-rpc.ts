import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";

import { z } from "zod";

// JSON-RPC client for monero-wallet-rpc (and monerod, which speaks the same
// envelope on /json_rpc). No env import: tests build clients for local nodes.
//
// With --rpc-login, monero-wallet-rpc asks for HTTP digest auth (RFC 7616 /
// 2617, qop "auth"), which fetch does not do, so it is done here: the first
// call gets a 401 with the challenge, later calls reuse it with a rising
// nonce count until the server issues a new nonce.
//
// The wallet (epee) keeps a nonce per TCP connection: an answer sent on
// another connection is refused as stale. So each client talks over one
// kept-alive socket (node:http, not fetch, whose pool may switch sockets).

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

// Amounts are piconero (10^-12 XMR) sent as bare JSON integers, which can
// pass 2^53. They travel as bigint here, both ways.
const BIGINT_MARK = `bigint-${randomBytes(8).toString("hex")}:`;

function stringifyWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? `${BIGINT_MARK}${item}` : item,
  ).replace(new RegExp(`"${BIGINT_MARK}(-?[0-9]+)"`, "g"), "$1");
}

/** Integers beyond Number's exact range come back as bigint; everything else as JSON.parse gives it. */
function parseWithBigints(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );
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

  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 1 });
  const timeoutMs = options.timeoutMs ?? 120_000;

  async function send(body: string, headers: Record<string, string>) {
    return await new Promise<{ status: number; authenticate: string | undefined; text: string }>((resolve, reject) => {
      const req = transport.request(
        target,
        { method: "POST", agent, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const authenticate = res.headers["www-authenticate"];
            resolve({
              status: res.statusCode ?? 0,
              authenticate: Array.isArray(authenticate) ? authenticate.join(", ") : authenticate,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
      req.on("error", reject);
      req.end(body);
    });
  }

  async function post(body: string) {
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
    return await send(body, headers);
  }

  async function callNow(method: string, params: Record<string, unknown>): Promise<MoneroRpcAnswer | undefined> {
    // Params can hold signed transactions and tx keys: never logged.
    const body = stringifyWithBigints({ jsonrpc: "2.0", id: "0", method, params });
    try {
      let res = await post(body);
      if (res.status === 401 && login) {
        challenge = pickChallenge(res.authenticate ?? null);
        nc = 0;
        if (challenge === undefined) {
          console.warn(`${label}: 401 without a usable digest challenge:`, method);
          return undefined;
        }
        res = await post(body);
      }
      if (res.status < 200 || res.status > 299) {
        console.warn(`${label} HTTP failed:`, method, res.status);
        return undefined;
      }
      const parsed = replySchema.safeParse(parseWithBigints(res.text));
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
