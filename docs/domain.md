# Project-specific facts

Industry knowledge lives in the shared library, not here:
- `/Users/leezh/Documents/Claudemd/domains/blockchain/general.md`
- `/Users/leezh/Documents/Claudemd/domains/blockchain/ton.md`

This file holds only facts about this project's code and setup.
Marks: ✅ verified by a run or seen in the code · 📄 cited source · ⚠️ unverified

## How this project works
- One deposit address per invoice. The backend holds its key and pays the merchant and the platform from it.
- TON payouts send two messages from the deposit address: merchant share and platform share. Both non-bounceable (see `docs/decisions/0001-…`).

## Red lines
- "Paid" is decided only by `paidExactly` in `src/transactions/ton.ts`: receiver + exact amount + non-bounceable. ✅ (code and tests)
- The mainnet address for the fixed test key must stay `UQA041P-aOeHTPWoEkr1y6dUDNMGFp9K1AORUeMYF0p2ycC_`. ✅ pinned by `tests/transactions/ton-payout.test.ts`.

## Facts
- Frozen accounts and non-wallet contracts are refused before sending. ⚠️ (from an agent report; check in code)
- TON has never run live: `PLATFORM_TON_ADDRESS` is not set and the NOWNodes key returns 401. ⚠️ (as of 2026-11-15)
- `src/storage/cryptos.json` is the list of supported coins. Its keys are also the `payout_addresses` keys. The key `bsc` means native BNB. ✅ seen in code.
- A payout address is checked by its coin's chain (BTC, LTC, EVM for ETH/BSC, SOL, TON) in `src/assets/payout-address.ts`. Tron and Monero answer "not supported yet". ✅ `tests/routes/invoice-create-addresses.test.ts`, run 25/25 on a throwaway `merchant_test` database, 2026-11-17.
- Invoice creation always makes a BTC deposit, and a BTC deposit can only be paid out as `btc` or `usdceth` (`canPayOutFromBtcDeposit` in `src/transactions/btc.ts`). Every other payout coin gets `409 PAYOUT_NOT_SUPPORTED` at creation, so no payer's BTC can be stranded. ✅ same test run.
- USDT on TON: jetton master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`, 6 decimals. 📄 docs.ton.org (WalletKit jettons).
- USDT on Tron: contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, 6 decimals. 📄 tron.network/usdt.
- DAI on BSC: contract `0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3` reports name "Dai Token", symbol DAI, 18 decimals. ✅ read from the chain with `eth_call`, 2026-11-17. ⚠️ An impostor could copy name and symbol: confirm BscScan labels it Binance-Peg DAI before any DAI-on-BSC payout code uses it.
- Payment check order: the watcher reads the chain first, then decides expiry. A full payment already there at the expiry check is on time, and a failed chain lookup never expires an invoice. ✅ `tests/invoice/watcher-pass.test.ts`, run 16/16, 2026-11-17.
- Underpaid tolerance: 0–5%, at most 2 decimals, stored on the invoice as `underpaid`. A payment is accepted when it is at least the amount less the tolerance, rounded up (`src/invoice/payment-rules.ts`). ✅ same run, plus `tests/routes/invoice-create-addresses.test.ts`.
- An invoice that expires with some money received gets `outcome: "partially_paid"`. Sending that money on is not built yet. ✅ same run.
- At a 0% fee, BTC, LTC, ETH and SOL send no platform transfer. TON always sends its second message, because it returns the unused network-fee allowance to the platform. ✅ seen in code (`btc.ts`, `ltc.ts`, `eth.ts`, `sol.ts`, `ton.ts`).
- API keys: only the keyed hash (blind index, purpose `api-key`) is stored, in `users.api_key_hash`. A logged-in merchant makes or replaces the key with `POST /auth/api-key`, and it is shown once. A key can only create invoices and read their status: it never opens `/auth/*`. ✅ `tests/routes/api-key.test.ts`, run 7/7, 2026-11-17.
- Keys issued before that change sit in plain text in `users.merchant_key` until `npx tsx src/scripts/hash-merchant-keys.ts` is run once on the real database. Until then those merchants get 401. ✅ `tests/scripts/hash-merchant-keys.test.ts` (test database only).
- The API key travels in a header named `merchant_key`. Some proxies (nginx by default) drop headers that contain underscores. ⚠️ unverified for your hosting.
- Login flow. ✅ `tests/routes/login-flow.test.ts`, run 13/13, 2026-11-17.
  - First login: `POST /auth/challenge {accountNumber}`, then the browser signs `"merchant-v3 <action>:" + challenge` (UTF-8 bytes) with Ed25519, where `<action>` is `login`, `reset-totp` or `new-account-number`. A signature works only for its own action. ✅ `tests/routes/recovery.test.ts`, 2026-11-17. The key is the first 32 bytes of the BIP-39 seed of the 12 words. Then `POST /auth/login/recovery {accountNumber, challenge, signature(base64url)}` returns a `totp_setup` session.
  - A `totp_setup` session can only call `/auth/2fa/setup` and `/auth/2fa/enable`. Enabling TOTP with one valid code swaps it for an `active` session.
  - Later logins: `POST /auth/login` (account number) gives a `pending_totp` session, then `/auth/2fa/verify` gives `active`. Without TOTP, `/auth/login` answers `409 RECOVERY_PHRASE_REQUIRED`.
  - An `active` session only works while the merchant's TOTP is on.
  - Challenges are single-use, last 5 minutes, and are stored only as SHA-256 hashes. An unknown account still gets a challenge, so accounts can't be probed.
- Recovery with the 12 words. The browser sends the recovery public key (it derives the key from the words), never the words. `POST /auth/challenge {recoveryPublicKey}`, then:
  - `POST /auth/recovery/reset-totp` switches TOTP off, ends every session, and returns a `totp_setup` session.
  - `POST /auth/recovery/new-account-number` returns a new number once; the old number and every session stop working.

  ✅ `tests/routes/recovery.test.ts`, run 6/6, 2026-11-17.
- Before 2026-11-17, `verifyUserTptp` filtered on `totp_enabled: false`, so no merchant with TOTP on could finish logging in. Fixed. ✅ same test run.
- The login rate limit is 5 requests per minute per address, shared by `/auth/challenge`, `/auth/login` and `/auth/login/recovery`, and 1,000 when `NODE_ENV=test`. ⚠️ the 5-per-minute limit itself has no test.
- Settings: `GET /settings`, and `PATCH /settings/{payout-addresses,refund-addresses,swap-max-loss,webhook-url}`. The fee rate is read-only: no route changes it. ✅ `tests/routes/settings.test.ts`, run 27/27, 2026-11-17.
  - These changes need a fresh code from the authenticator (`totpCode`, single use): payout or refund addresses, webhook URL, `POST /auth/api-key`, and replacing the device (`/auth/2fa/replace/start` with the current code, then `/replace/confirm` with the new device's code).
  - Swap max loss is 0.5–5% (stored as `swap_max_loss_bps`, 50–500) and needs no code.
  - The webhook URL must be https with no credentials in it. Delivery refuses private addresses (see Webhooks below).
- `payout_addresses` and `refund_addresses` share one per-coin field list, and a test keeps it equal to the keys of `cryptos.json`. ✅ `tests/assets/coin-list.test.ts`.
- Webhooks. ✅ `tests/webhooks/webhook-pass.test.ts` (8/8), `tests/webhooks/destination.test.ts` (16/16) and `tests/routes/webhook-secret.test.ts` (2/2), 2026-11-17. A 4-second server boot against a test database showed the sender starting and stopping, also 2026-11-17.
  - **Timing:** every 15 s, `src/webhooks/webhook-pass.ts` records each invoice whose `status` differs from `notified_status` as an event, then sends the events that are due. Two status changes between passes produce one webhook with the latest status. Each change is recorded under a fixed id (`<invoiceId>:<from>-><to>`) before it is marked announced, so a crash in between can't lose or duplicate it. ✅ `tests/webhooks/webhook-pass.test.ts` (10/10), 2026-11-17.
  - **Request:** `POST` with `content-type: application/json`, `x-webhook-timestamp: <unix seconds>`, and `x-webhook-signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`. The body is `{event:"invoice.status_changed", eventId, invoiceId, status, outcome, crypto, toCrypto, amount, amountFiat, paidAmount, platformFee, networkFee, merchantAmount, txids:{in,out,platformOut}, occurredAt}`. Merchants should dedupe by `eventId`.
  - **Retries:** after 1 min, 5 min, 30 min and 2 h; the 5th failure marks the event failed. A redirect counts as a failure and is never followed.
  - **Destinations:** https only, and every address the name resolves to must be public (no loopback, private, link-local or metadata ranges). ⚠️ The name is resolved again when the request is sent, so DNS rebinding is not covered.
  - **Secret:** `whsec_…`, shown once when the first webhook URL is set; `POST /settings/webhook-secret` with a TOTP code replaces it. It is stored sealed (`webhook-secret`), because it is needed to sign.
- Payer's page, public and keyed by the invoice's random UUID: `GET /pay/:id`, `POST /pay/:id/choose {crypto}` (once, before expiry), and `POST /pay/:id/cancel` (only while status is `waiting` and `paid_amount` is `"0"`). It never shows the merchant's id or payout addresses. ✅ `tests/routes/pay-page.test.ts`, run 13/13, 2026-11-17.
- `mode: "merchant_list"` invoices start with no deposit address, `amount: "0"` and `offered_coins`. Offered coins are the merchant's valid payout coins that are also in `WATCHED_COINS` (only `btc` and `ton` today), so they can be detected and paid out directly. Choosing a coin locks its price and creates the deposit; the invoice timer still runs from creation. The watcher expires invoices where no coin was picked in time. ✅ same run, plus `tests/invoice/watcher-pass.test.ts`.
- A deposit address always comes with its key: the model requires `private.private_key` whenever `address` is set. ✅ seen in `src/database/invoices.model.ts`.
- `createApp({ getPrice })` lets tests inject prices; production uses the exchange prices in `src/invoice/price.function.ts`. ✅ seen in `src/app.ts`.
- The watcher, the BTC payout and the TON payout all use one minimum, `acceptedPaymentAmount`, tolerance included. Before 2026-11-17 the payouts waited for the full amount, so an invoice confirmed within tolerance never paid out. ✅ `tests/invoice/payment-rules.test.ts`. ⚠️ The payouts are not tested with this change; they need the chain tests.
- Fixed-coin invoices take BTC deposits only. Any other `crypto` gets `409 DEPOSIT_COIN_NOT_SUPPORTED` instead of quietly becoming a BTC invoice. ✅ `tests/routes/pay-page.test.ts` (14/14), 2026-11-17.
- **No database indexes are ever created.** Every model has `autoIndex: false`, and nothing calls `createIndexes`. The unique indexes on `invoice_id`, `account_hash`, `api_key_hash`, `recovery_public_key`, `challengeHash` and `eventId`, and the TTL indexes on sessions and login challenges, exist only in the schemas. Code that relies on a duplicate-key error (error 11000) never gets one. ✅ checked with grep, 2026-11-17.
- Known limits of "on time" (R1): there are no first-seen times, only totals. While chain lookups fail, an invoice never expires, so a payment that arrives during an outage counts as on time. A payment that lands in the 15 s between passes also counts. ⚠️ needs first-seen times from the chain-data code.
- Cancel race: cancel checks the stored `paid_amount`, which can be up to 15 s old, and cancelled invoices are not watched. Money sent just before a cancel is not recorded. ⚠️ the watch window and refund routing (ticket 6) will close this.
- Merchants created before 2026-11-17 keep `merchant_fee: "0.005"`. Only new merchants get 5%. ⚠️ the owner decides whether to migrate them.
- `required_confirmations` is still 1 for every coin. The approved per-chain numbers wait for a check against each chain's docs. ✅ seen in `cryptos.json`.

## Pitfalls
- Tests call `deleteMany` on the database they connect to. `npm test` is now guarded (branch `launch-groundwork`): it refuses to start unless `MONGODB_DATABASE` ends in `_test`, never reads `.env`, and `connectToMongoDb` refuses a non-`_test` name whenever `NODE_ENV=test`. ✅ `tests/infrastructure/test-database-guard.test.ts`, and a full `npm test` run (87/87) on a throwaway `merchant_test` database, 2026-11-17.
- Running a single test file directly with `node --test` skips the npm `pretest` check. Add `--import ./tests/setup/test-guard.ts`, as in the `test` script. ✅ seen in `package.json`.
- 28 old files (27 tests that import deleted modules or functions, plus their helper) live in `legacy-tests/`, outside the test run. ✅ moved with `git mv` on 2026-11-17.
