import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { createMoneroRpc, digestAuthorization } from "../../src/chains/monero-rpc.js";

// The monero-wallet-rpc / monerod JSON-RPC client. Digest auth is what
// monero-wallet-rpc asks for when it runs with --rpc-login; fetch has none.
// The regtest suite (tests/chains/monero/xmr-payouts.test.ts) runs it against
// a real wallet started with --rpc-login.

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

describe("digest authorization", () => {
  it("matches the RFC 2617 example (section 3.5)", () => {
    const header = digestAuthorization({
      username: "Mufasa",
      password: "Circle Of Life",
      method: "GET",
      uri: "/dir/index.html",
      challenge: { realm: "testrealm@host.com", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", qop: "auth", algorithm: "MD5", opaque: "5ccc069c403ebaf9f0171e9517f40e41" },
      nc: 1,
      cnonce: "0a4f113b",
    });
    assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
    assert.match(header, /^Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="\/dir\/index.html"/);
    assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
    assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  });
});

// A server that asks for digest auth the way monero-wallet-rpc does: one 401
// carrying two challenges (MD5-sess and MD5), and a fresh nonce now and then.
let server: Server;
let url: string;
let nonce = randomBytes(8).toString("hex");
const seen: { authorized: boolean; nc?: string }[] = [];
let answer: (method: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

function authorized(req: IncomingMessage): { ok: boolean; nc?: string } {
  const header = req.headers.authorization;
  if (!header?.startsWith("Digest ")) return { ok: false };
  const field = (name: string) => new RegExp(`${name}="?([^",]+)"?`).exec(header)?.[1];
  if (field("nonce") !== nonce || field("username") !== "alice" || field("algorithm") !== "MD5") return { ok: false, nc: field("nc") };
  const ha1 = md5(`alice:monero-rpc:s3cret`);
  const ha2 = md5(`POST:${field("uri")}`);
  const expected = md5(`${ha1}:${nonce}:${field("nc")}:${field("cnonce")}:auth:${ha2}`);
  return { ok: field("response") === expected, nc: field("nc") };
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const auth = authorized(req);
      seen.push({ authorized: auth.ok, ...(auth.nc && { nc: auth.nc }) });
      if (!auth.ok) {
        res.writeHead(401, {
          "www-authenticate": [
            `Digest qop="auth",algorithm=MD5-sess,realm="monero-rpc",nonce="${nonce}",stale=false`,
            `Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="${nonce}",stale=false`,
          ],
        });
        return res.end();
      }
      const { method } = JSON.parse(body) as { method: string };
      const reply = answer(method);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/json_rpc`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("the Monero JSON-RPC client", () => {
  it("answers a 401 with digest auth, then reuses the challenge with a rising nonce count", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { jsonrpc: "2.0", id: "0", result: { version: 1 } } });
    const rpc = createMoneroRpc({ url, login: { username: "alice", password: "s3cret" } });

    assert.deepEqual(await rpc.call("get_version"), { result: { version: 1 } });
    assert.deepEqual(await rpc.call("get_version"), { result: { version: 1 } });

    assert.deepEqual(seen, [{ authorized: false }, { authorized: true, nc: "00000001" }, { authorized: true, nc: "00000002" }]);
  });

  it("takes a new nonce when the server changes it", async () => {
    seen.length = 0;
    const rpc = createMoneroRpc({ url, login: { username: "alice", password: "s3cret" } });
    await rpc.call("get_version");
    nonce = randomBytes(8).toString("hex");

    assert.deepEqual(await rpc.call("get_version"), { result: { version: 1 } });
    assert.deepEqual(seen.map((s) => s.authorized), [false, true, false, true]);
    assert.equal(seen[3]!.nc, "00000001");
  });

  it("gives up after one retry with a wrong password", async () => {
    seen.length = 0;
    const rpc = createMoneroRpc({ url, login: { username: "alice", password: "wrong" } });

    assert.equal(await rpc.call("get_version"), undefined);
    assert.equal(seen.length, 2);
  });

  it("hands back a JSON-RPC error with its code, and undefined for a broken reply", async () => {
    const rpc = createMoneroRpc({ url, login: { username: "alice", password: "s3cret" } });

    answer = () => ({ status: 200, body: { jsonrpc: "2.0", id: "0", error: { code: -16, message: "tx not possible" } } });
    assert.deepEqual(await rpc.call("transfer", {}), { error: { code: -16, message: "tx not possible" } });

    answer = () => ({ status: 500, body: {} });
    assert.equal(await rpc.call("get_version"), undefined);

    answer = () => ({ status: 200, body: { jsonrpc: "2.0", id: "0" } });
    assert.equal(await rpc.call("get_version"), undefined);
  });

  it("answers undefined when nothing listens", async () => {
    const rpc = createMoneroRpc({ url: "http://127.0.0.1:1/json_rpc" });

    assert.equal(await rpc.call("get_version"), undefined);
  });
});
