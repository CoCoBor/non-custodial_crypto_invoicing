import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Db } from "mongodb";

import { generateTotpCode } from "../../src/auth/totp.function.js";
import { logIn, postJson, registerMerchant, startTestApp } from "../helpers/http-app.js";
import { freshTotpCode } from "../helpers/totp.js";

// Settings, and the TOTP code that guards the critical ones.
// Needs a test database: MONGODB_URI=… MONGODB_DATABASE=merchant_test npm test

const BTC_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const ETH_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TRON_ADDRESS = "TVzYu8aczxtWAF2JmcEZEUapsYqtUWDU1p";
const XMR_ADDRESS = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
// From Monero's tests/functional_tests/validate_address.py.
const XMR_SUBADDRESS = "8AsN91rznfkBGTY8psSNkJBg9SZgxxGGRUhGwRptBhgr5XSQ1XzmA9m8QAnoxydecSh5aLJXdrgXwTDMMZ1AuXsN1EX5Mtm";
const XMR_STAGENET_ADDRESS = "53teqCAESLxeJ1REzGMAat1ZeHvuajvDiXqboEocPaDRRmqWoVPzy46GLo866qRFjbNhfkNckyhST3WEvBviDwpUDd7DSzB";
const XMR_INTEGRATED_ADDRESS = "4BxSHvcgTwu25WooY4BVmgdcKwZu5EksVZSZkDd6ooxSVVqQ4ubxXkhLF6hEqtw96i9cf3cVfLw8UWe95bdDKfRQeYtPwLm1Jiw7AKt2LY";

let baseUrl: string;
let db: Db;
let stop: () => Promise<void>;
const userIds: string[] = [];

before(async () => {
  ({ baseUrl, db, stop } = await startTestApp());
});

after(async () => {
  await db.collection("users").deleteMany({ user_id: { $in: userIds } });
  await db.collection("sessions").deleteMany({ userId: { $in: userIds } });
  await stop();
});

async function merchant() {
  const registered = await registerMerchant(baseUrl);
  userIds.push(registered.userId);
  const { cookie, totpSecret } = await logIn(baseUrl, registered);
  const code = () => freshTotpCode(db, registered.userId, totpSecret);
  return { ...registered, cookie, totpSecret, code };
}

async function patch(path: string, cookie: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function settingsOf(cookie: string) {
  const response = await fetch(`${baseUrl}/settings`, { headers: { cookie } });
  return { status: response.status, body: await response.json() };
}

async function user(userId: string) {
  return await db.collection("users").findOne({ user_id: userId });
}

describe("reading settings", () => {
  it("shows the fee rate (read-only), no addresses, the default max loss and no webhook", async () => {
    const m = await merchant();

    const { status, body } = await settingsOf(m.cookie);

    assert.equal(status, 200);
    assert.equal(body.data.feeRate, "0.05");
    assert.equal(body.data.swapMaxLossPercent, 0.5);
    assert.equal(body.data.webhookUrl, "");
    assert.equal(body.data.payoutAddresses.btc, "");
    assert.equal(body.data.refundAddresses.btc, "");
  });

  it("needs a full session", async () => {
    assert.equal((await settingsOf("session=nope")).status, 401);
  });
});

describe("payout and refund addresses", () => {
  for (const kind of ["payout", "refund"] as const) {
    const field = `${kind}_addresses`;

    it(`saves a valid ${kind} address with a TOTP code`, async () => {
      const m = await merchant();

      const response = await patch(`/settings/${kind}-addresses`, m.cookie, {
        asset: "btc",
        address: BTC_ADDRESS,
        totpCode: await m.code(),
      });

      assert.equal(response.status, 200);
      assert.equal((await user(m.userId))?.[field].btc, BTC_ADDRESS);
    });

    it(`refuses to save a ${kind} address without a TOTP code`, async () => {
      const m = await merchant();

      const response = await patch(`/settings/${kind}-addresses`, m.cookie, { asset: "btc", address: BTC_ADDRESS });

      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, "TOTP_REQUIRED");
      assert.equal((await user(m.userId))?.[field].btc, "");
    });

    it(`refuses a ${kind} address from the wrong chain`, async () => {
      const m = await merchant();

      const response = await patch(`/settings/${kind}-addresses`, m.cookie, {
        asset: "sol",
        address: ETH_ADDRESS,
        totpCode: await m.code(),
      });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "ADDRESS_INVALID");
    });

    it(`saves a Tron ${kind} address for USDT on Tron, and refuses its hex form`, async () => {
      const m = await merchant();

      const saved = await patch(`/settings/${kind}-addresses`, m.cookie, {
        asset: "usdttrx",
        address: TRON_ADDRESS,
        totpCode: await m.code(),
      });
      const hex = await patch(`/settings/${kind}-addresses`, m.cookie, {
        asset: "usdttrx",
        address: "41dba38a9ecfc0e6bf49c182dab4848bcbcd23e5d5",
        totpCode: await m.code(),
      });

      assert.equal(saved.status, 200);
      assert.equal(hex.status, 409);
      assert.equal(hex.body.error.code, "ADDRESS_INVALID");
      assert.equal((await user(m.userId))?.[field].usdttrx, TRON_ADDRESS);
    });

    it(`saves a Monero ${kind} address (standard or subaddress), and refuses stagenet and integrated ones`, async () => {
      const m = await merchant();

      const standard = await patch(`/settings/${kind}-addresses`, m.cookie, {
        asset: "xmr",
        address: XMR_ADDRESS,
        totpCode: await m.code(),
      });
      const subaddress = await patch(`/settings/${kind}-addresses`, m.cookie, {
        asset: "xmr",
        address: XMR_SUBADDRESS,
        totpCode: await m.code(),
      });
      const stagenet = await patch(`/settings/${kind}-addresses`, m.cookie, {
        asset: "xmr",
        address: XMR_STAGENET_ADDRESS,
        totpCode: await m.code(),
      });

      const integrated = await patch(`/settings/${kind}-addresses`, m.cookie, {
        asset: "xmr",
        address: XMR_INTEGRATED_ADDRESS,
        totpCode: await m.code(),
      });

      assert.equal(standard.status, 200);
      assert.equal(subaddress.status, 200);
      assert.equal(stagenet.status, 409);
      assert.equal(stagenet.body.error.code, "ADDRESS_INVALID");
      assert.equal(integrated.status, 409);
      assert.equal(integrated.body.error.code, "ADDRESS_INVALID");
      assert.equal((await user(m.userId))?.[field].xmr, XMR_SUBADDRESS);
    });
  }

  it("clears an address with an empty string, still with a TOTP code", async () => {
    const m = await merchant();
    await patch("/settings/payout-addresses", m.cookie, { asset: "btc", address: BTC_ADDRESS, totpCode: await m.code() });

    const response = await patch("/settings/payout-addresses", m.cookie, { asset: "btc", address: "", totpCode: await m.code() });

    assert.equal(response.status, 200);
    assert.equal((await user(m.userId))?.payout_addresses.btc, "");
  });

  it("refuses a coin the platform does not list", async () => {
    const m = await merchant();

    const response = await patch("/settings/payout-addresses", m.cookie, { asset: "doge", address: "x", totpCode: await m.code() });

    assert.equal(response.status, 400);
  });

  it("never accepts the same TOTP code twice", async () => {
    const m = await merchant();
    const code = await m.code();

    const first = await patch("/settings/payout-addresses", m.cookie, { asset: "btc", address: BTC_ADDRESS, totpCode: code });
    const replay = await patch("/settings/refund-addresses", m.cookie, { asset: "btc", address: BTC_ADDRESS, totpCode: code });

    assert.equal(first.status, 200);
    assert.equal(replay.status, 401);
    assert.equal((await user(m.userId))?.refund_addresses.btc, "");
  });
});

describe("swap max loss", () => {
  it("can be set from 0.5% to 5% without a TOTP code", async () => {
    const m = await merchant();

    const response = await patch("/settings/swap-max-loss", m.cookie, { percent: 2.5 });

    assert.equal(response.status, 200);
    assert.equal((await user(m.userId))?.swap_max_loss_bps, 250);
    assert.equal((await settingsOf(m.cookie)).body.data.swapMaxLossPercent, 2.5);
  });

  for (const percent of [0.4, 5.01, 0.123, "1"]) {
    it(`refuses ${JSON.stringify(percent)}`, async () => {
      const m = await merchant();

      const response = await patch("/settings/swap-max-loss", m.cookie, { percent });

      assert.equal(response.status, 400);
      assert.equal((await user(m.userId))?.swap_max_loss_bps, 50);
    });
  }
});

describe("webhook URL", () => {
  it("is saved with a TOTP code", async () => {
    const m = await merchant();

    const response = await patch("/settings/webhook-url", m.cookie, { url: "https://shop.example/hooks/pay", totpCode: await m.code() });

    assert.equal(response.status, 200);
    assert.equal((await user(m.userId))?.webhook_url, "https://shop.example/hooks/pay");
  });

  it("needs a TOTP code", async () => {
    const m = await merchant();

    const response = await patch("/settings/webhook-url", m.cookie, { url: "https://shop.example/hook" });

    assert.equal(response.status, 401);
  });

  for (const url of ["http://shop.example/hook", "not a url", "https://user:pass@shop.example/hook"]) {
    it(`refuses ${url}`, async () => {
      const m = await merchant();

      const response = await patch("/settings/webhook-url", m.cookie, { url, totpCode: await m.code() });

      assert.equal(response.status, 400);
    });
  }
});

describe("what a merchant can't change", () => {
  it("has no way to change the fee rate", async () => {
    const m = await merchant();

    const response = await patch("/settings", m.cookie, { merchant_fee: "0", totpCode: await m.code() });

    assert.equal(response.status, 404);
    assert.equal((await user(m.userId))?.merchant_fee, "0.05");
  });
});

describe("API keys need a TOTP code", () => {
  it("refuses to make a key without one", async () => {
    const m = await merchant();

    const response = await postJson(`${baseUrl}/auth/api-key`, {}, { cookie: m.cookie });

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "TOTP_REQUIRED");
  });
});

describe("replacing the TOTP device", () => {
  it("needs the current device's code, then a code from the new device", async () => {
    const m = await merchant();

    const start = await postJson(`${baseUrl}/auth/2fa/replace/start`, { totpCode: await m.code() }, { cookie: m.cookie });
    assert.equal(start.status, 200);
    const newSecret: string = start.body.data.secret;
    assert.notEqual(newSecret, m.totpSecret);

    const confirm = await postJson(
      `${baseUrl}/auth/2fa/replace/confirm`,
      { code: generateTotpCode(newSecret) },
      { cookie: m.cookie },
    );
    assert.equal(confirm.status, 200);

    // The old device no longer works; the new one does.
    const oldCode = await freshTotpCode(db, m.userId, m.totpSecret);
    const withOld = await patch("/settings/webhook-url", m.cookie, { url: "https://a.example/h", totpCode: oldCode });
    assert.equal(withOld.status, 401);
    const newCode = await freshTotpCode(db, m.userId, newSecret);
    const withNew = await patch("/settings/webhook-url", m.cookie, { url: "https://a.example/h", totpCode: newCode });
    assert.equal(withNew.status, 200);
  });

  it("can't start without the current device's code", async () => {
    const m = await merchant();

    const start = await postJson(`${baseUrl}/auth/2fa/replace/start`, { totpCode: "000000" }, { cookie: m.cookie });

    assert.equal(start.status, 401);
  });

  it("keeps the old device if the new device's code is wrong", async () => {
    const m = await merchant();
    await postJson(`${baseUrl}/auth/2fa/replace/start`, { totpCode: await m.code() }, { cookie: m.cookie });

    const confirm = await postJson(`${baseUrl}/auth/2fa/replace/confirm`, { code: "000000" }, { cookie: m.cookie });

    assert.equal(confirm.status, 409);
    const oldCode = await freshTotpCode(db, m.userId, m.totpSecret);
    const stillOld = await patch("/settings/webhook-url", m.cookie, { url: "https://a.example/h", totpCode: oldCode });
    assert.equal(stillOld.status, 200);
  });
});
