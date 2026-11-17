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
  - First login: `POST /auth/challenge {accountNumber}`, then the browser signs `"merchant-v3 login:" + challenge` (UTF-8 bytes) with Ed25519. The key is the first 32 bytes of the BIP-39 seed of the 12 words. Then `POST /auth/login/recovery {accountNumber, challenge, signature(base64url)}` returns a `totp_setup` session.
  - A `totp_setup` session can only call `/auth/2fa/setup` and `/auth/2fa/enable`. Enabling TOTP with one valid code swaps it for an `active` session.
  - Later logins: `POST /auth/login` (account number) gives a `pending_totp` session, then `/auth/2fa/verify` gives `active`. Without TOTP, `/auth/login` answers `409 RECOVERY_PHRASE_REQUIRED`.
  - An `active` session only works while the merchant's TOTP is on.
  - Challenges are single-use, last 5 minutes, and are stored only as SHA-256 hashes. An unknown account still gets a challenge, so accounts can't be probed.
- Before 2026-11-17, `verifyUserTptp` filtered on `totp_enabled: false`, so no merchant with TOTP on could finish logging in. Fixed. ✅ same test run.
- The login rate limit is 5 requests per minute per address, shared by `/auth/challenge`, `/auth/login` and `/auth/login/recovery`, and 1,000 when `NODE_ENV=test`. ⚠️ the 5-per-minute limit itself has no test.
- `required_confirmations` is still 1 for every coin. The approved per-chain numbers wait for a check against each chain's docs. ✅ seen in `cryptos.json`.

## Pitfalls
- Tests call `deleteMany` on the database they connect to. `npm test` is now guarded (branch `launch-groundwork`): it refuses to start unless `MONGODB_DATABASE` ends in `_test`, never reads `.env`, and `connectToMongoDb` refuses a non-`_test` name whenever `NODE_ENV=test`. ✅ `tests/infrastructure/test-database-guard.test.ts`, and a full `npm test` run (87/87) on a throwaway `merchant_test` database, 2026-11-17.
- Running a single test file directly with `node --test` skips the npm `pretest` check. Add `--import ./tests/setup/test-guard.ts`, as in the `test` script. ✅ seen in `package.json`.
- 28 old files (27 tests that import deleted modules or functions, plus their helper) live in `legacy-tests/`, outside the test run. ✅ moved with `git mv` on 2026-11-17.
