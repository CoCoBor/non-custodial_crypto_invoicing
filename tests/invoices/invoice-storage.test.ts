import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import bitcore from "bitcore-lib";

import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "../../src/infrastructure/database/mongodb.js";
import { generateDepositAddress } from "../../src/chains/bitcoin/deposit-address.js";
import { openSecret } from "../../src/security/secret-envelope.js";
import { savePreparedInvoice } from "../../src/invoices/invoice.repository.js";
import { Invoice } from "../../src/invoices/invoice.schema.js";

test("stored encrypted key recovers the invoice deposit address", async () => {
  const merchantKey = `storage-test-${randomUUID()}`;
  const deposit = generateDepositAddress();

  await connectToMongoDb();

  try {
    const saved = await savePreparedInvoice({
      currency: "usd",
      crypto: "btc",

      // 测试数据，不是真实报价。
      amount: 0.001,
      amount_fiat: 100,
      lifetime: 30,
      underpaid: 0,
      fee_paid_by_payer: false,
      network_fee: 0,
      platform_fee: 0,
      swap_fee: 0,

      deposit,
      merchantKey,
      paymentUrl: "https://example.invalid/pay",
      paymentBotPrefix: "https://example.invalid/bot/",
    });

    // 对外返回的数据不能带加密私钥或 Merchant key。
    assert.equal(Object.hasOwn(saved, "private"), false);
    assert.equal(saved.status, "waiting");

    // 真正重新查询数据库，而不是检查刚生成的内存对象。
    const stored = await Invoice.findOne({ id: saved.id });
    assert.ok(stored);

    const sealed = stored.private?.private_key;
    assert.ok(sealed);

    const recoveredWif = openSecret("bitcoin-deposit-key", {
      keyVersion: sealed.keyVersion,
      initialisationVector: Buffer.from(sealed.initialisationVector),
      authenticationTag: Buffer.from(sealed.authenticationTag),
      ciphertext: Buffer.from(sealed.ciphertext),
    });

    const recoveredKey = new bitcore.PrivateKey(recoveredWif);

    assert.equal(stored.address, deposit.address);
    assert.equal(
      recoveredKey.toAddress().toString(),
      stored.address,
    );
  } finally {
    try {
      // 只删除本次测试生成的记录。
      await Invoice.deleteOne({
        "private.merchant_key": merchantKey,
        address: deposit.address,
      });
    } finally {
      await disconnectFromMongoDB();
    }
  }
});