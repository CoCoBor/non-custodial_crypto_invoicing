import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAllowedWebhookDestination } from "../../src/webhooks/destination.js";

// Webhooks are sent by our server to an address the merchant typed in: it
// must never be our own network (SSRF).

function resolvingTo(...addresses: string[]) {
  return async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

describe("which webhook destinations are allowed", () => {
  it("allows https to a public address", async () => {
    assert.equal(await isAllowedWebhookDestination(new URL("https://shop.example/h"), resolvingTo("93.184.215.14")), true);
  });

  it("refuses plain http", async () => {
    assert.equal(await isAllowedWebhookDestination(new URL("http://shop.example/h"), resolvingTo("93.184.215.14")), false);
  });

  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1",
  ]) {
    it(`refuses a name that resolves to ${address}`, async () => {
      assert.equal(await isAllowedWebhookDestination(new URL("https://shop.example/h"), resolvingTo(address)), false);
    });
  }

  it("refuses when any one of the resolved addresses is private", async () => {
    assert.equal(
      await isAllowedWebhookDestination(new URL("https://shop.example/h"), resolvingTo("93.184.215.14", "10.0.0.1")),
      false,
    );
  });

  it("refuses an address typed as an IP literal in a private range", async () => {
    assert.equal(await isAllowedWebhookDestination(new URL("https://192.168.0.10/h"), resolvingTo("192.168.0.10")), false);
  });

  it("refuses when the name does not resolve", async () => {
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    assert.equal(await isAllowedWebhookDestination(new URL("https://nowhere.example/h"), failing), false);
  });
});
