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

## Chain adapter contract

The only way the invoice code reaches a chain. Types: `src/chains/adapter.ts`. Registry: `src/chains/registry.ts`, one line per deposit asset, keyed by asset id. The watcher, deposit creation, the payer's coin list, the fixed-coin creation check and the payer-pays estimate all go through it. ✅ `tests/invoice/watcher-pass.test.ts` (fake adapter at the registry seam, 49/49), `tests/chains/registry.test.ts` (10/10), 2026-11-18.

Units: money is `bigint` in the asset's smallest unit. Times are unix ms. A fee rate is a `bigint` in `FEE_RATE_SCALE` (10^8) units, so 5% = 5,000,000.

What an adapter supplies:
- `asset`: the deposit asset it serves. It must equal its registry key.
- `requiredConfirmations`: read from `src/storage/cryptos.json`.
- `isValidAddress(address)`: the chain's rule from `src/assets/payout-address.ts`. Before the first payout call, the watcher checks the destination with it. If the check fails, the invoice fails and the adapter is never called.
- `canPayOutAs(receiveAsset)`: true for its own asset. Only BTC also says yes to `usdceth` (the legacy NEAR swap; ticket 15 removes it).
- `newDeposit()`: `{ address, key }`. The key is `{ kind: "sealed_key", sealed }`, or for XMR `{ kind: "subaddress", index }`. It is async, and every caller awaits it.
- `getPayments(address)`: every incoming payment the chain shows now. Each one has `txid`, `amount` (what the address received and kept, summed per transaction), `confirmations`, and `seenAt` (the provider's first-seen or block time) when there is one. Two rules:
  - Return `undefined` when the lookup failed or the list may be incomplete.
  - Never return `[]` for a failure, because the watcher would read "nothing was paid".
- `estimateNetworkCost()`: what paying out one payment is expected to cost. `undefined` means it is unavailable right now.
- `payout(request)`: see below.

`payout(request)`. The request carries:
- `depositAddress`, `depositKey`.
- `destination`, a parameter: the adapter never reads the invoice. A refund route passes the merchant's refund (or payout) address here with `destinationKind: "refund_route"`, and `minimumAmount: 1` (see "Refund routing and the 7-day watch").
- `receiveAsset`.
- `feeRate`: the invoice's rate.
- `minimumAmount`: do not pay out until the deposit holds at least this much.
- `checkpoint`: the last one this adapter saved for this payout.
- `saveCheckpoint(next)`.

The result is one of:
- `paid`: the chain proves it. `transfers` lists every transfer the payout made (`kind`, `to`, `amount`, `txid`), with the real amounts and final txids. Kinds: `gas_top_up`, `merchant_payout`, `platform_fee`, `refund_route`, `swap_deposit`. The watcher marks the invoice `completed`; a legacy swap stays `processing` until NEAR finishes.
- `pending`: not finished, and nothing is wrong that waiting won't fix. Examples: an API is down, the deposit is below `minimumAmount`, the payout was sent and has not landed, or it waits for a confirmation. Call again next pass. An optional `review` note goes to `review_reason` while retrying stays safe. After 24 h in `processing`, the watcher writes a "not finished" note on its own.
- `too_small`: the fee and network cost would take it all, or leave less than the chain's dust or rent minimum. Nothing was sent. The money stays at the deposit and the invoice gets `outcome: "too_small_to_forward"`. A merchant payout keeps `status: "confirmed"` and is tried again every pass, so a top-up is swept with it; a refund route is tried again at the next look. ✅ `tests/invoice/refund-routing.test.ts` (37/37), 2026-11-18.
- `failed`: a person must act. `message` says where the money is and how to recover it (story 76). `transfers` lists what really moved, if anything. The watcher marks the invoice `failed`, stores the message in `review_reason`, marks the planned transfers `failed`, and stops calling.

Paying twice. The watcher may call `payout` again at any point, for example after a crash between two steps. An adapter must:
1. Never broadcast before `saveCheckpoint(next)` has returned true. The checkpoint holds what is needed to recognise the transaction on chain: the signed bytes, the txid, and the seqno or nonce it uses. If it returns false, another run owns the payout: broadcast nothing and return `pending`. The watcher saves with compare-and-set: first on `status: "confirmed"`, then on the previous `state`.
2. With a checkpoint, first find out whether the saved transaction landed. While it can still land, re-send the same signed bytes. Build a new one only when the old one can provably never land, and save it before sending:
   - TON: `valid_until` has passed and the seqno is still unused, and the rebuild reuses that seqno.
   - BTC: today it only re-sends the saved hex; a rebuild would spend the same outputs, so at most one could confirm.
   - EVM: reuse the same nonce.
3. Called again after `paid` (for example, the watcher crashed before recording it), return the same proof and send nothing.
4. Never touch the database or the invoice. Everything comes in the request.

What the watcher stores:
- When a checkpoint is saved:
  - `state` goes to `tx.raw` (not selected by default).
  - The planned transfers go to `transfers[]` as `pending`.
  - `platform_fee`, `network_fee` and `received_amount` are filled.
  - `tx.out` and `tx.platform_out` get the planned txids.
- On `paid`: the transfers become `confirmed` with the proven amounts, and `tx.out` gets the final txid.
- The old fields stay filled for the webhook and old readers.
- A refund route stores none of the above. Its checkpoint goes to its own `refund_routes[]` element (`raw`, `swept`, fees), and its transfers go to `transfers[]` tagged `payout: n`. `tx.*`, `platform_fee`, `network_fee` and `received_amount` keep describing the merchant payout. ✅ `tests/invoice/refund-routing.test.ts`, 2026-11-18.
- Invoices claimed before this contract have only `tx.raw`. They get `plan.transfers: []` back, so an adapter must not depend on it.

Checklist for a new chain adapter:
1. Add `src/chains/<chain>.ts` exporting `create<Chain>Adapter(deps)`, and one line per deposit asset in `src/chains/registry.ts`.
2. Add the chain's address rule to `addressRuleByChain` in `src/assets/payout-address.ts`, and point `isValidAddress` at it. `tests/chains/registry.test.ts` fails otherwise.
3. Read `requiredConfirmations` from `cryptos.json`.
4. Make network calls through an injectable client (like `TonApi`), so tests can run against an emulator or regtest node.
5. `getPayments`:
   - `undefined` on any failure, and for a list that may be incomplete;
   - one entry per transaction;
   - value that bounced back to the payer is not a payment;
   - `seenAt` whenever the provider gives a time.
6. `payout`:
   - follows the four rules above;
   - splits with `splitPayout` (F1), with network costs from the merchant's share;
   - sends no platform transfer at a 0% fee (story 31);
   - tops up gas from the gas wallet and reports it as `gas_top_up`, saving a checkpoint before each broadcast.
7. Every `failed` message names the deposit address and what to do.
8. Tests on a local emulator or regtest node, never mainnet:
   - the exact amount arrives;
   - a failed payout gives a where-the-money-is message;
   - a lost `saveCheckpoint` sends nothing;
   - a call after `paid` does not pay twice.
   Chain-data parsing is tested on recorded fixtures.

## Facts
- Non-wallet contracts are refused before sending: the payout fails with "not a normal TON wallet" and "All funds are still at deposit address …", and nothing moves. ✅ `tests/chains/ton-adapter.test.ts` (@ton/sandbox), 2026-11-18. Frozen receivers are refused the same way. ⚠️ seen in code (`prepareTonPayout`), not tested.
- TON has never run live: `PLATFORM_TON_ADDRESS` is not set and the NOWNodes key returns 401. ⚠️ (as of 2026-11-15)
- `src/storage/cryptos.json` is the list of supported coins. Its keys are also the `payout_addresses` keys. The key `bsc` means native BNB. ✅ seen in code.
- A payout address is checked by its coin's chain (BTC, LTC, EVM for ETH/BSC, SOL, TON) in `src/assets/payout-address.ts`. Tron and Monero answer "not supported yet". ✅ `tests/routes/invoice-create-addresses.test.ts`, run 25/25 on a throwaway `merchant_test` database, 2026-11-17.
- A fixed-coin invoice's deposit coin (`crypto`) must have a chain adapter (`btc`, `ton` today), and the adapter must be able to pay it out as `to_crypto` (`canPayOutAs`). A TON deposit pays out only as `ton`; a BTC deposit as `btc` or `usdceth` (`canPayOutFromBtcDeposit`, the legacy NEAR swap). Anything else gets `409 PAYOUT_NOT_SUPPORTED` at creation, so no payer's coins can be stranded. ✅ `tests/routes/invoice-create-addresses.test.ts` (32/32) and `tests/routes/pay-page.test.ts` (16/16), 2026-11-18.
- USDT on TON: jetton master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`, 6 decimals. 📄 docs.ton.org (WalletKit jettons).
- USDT on Tron: contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, 6 decimals. 📄 tron.network/usdt.
- DAI on BSC: contract `0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3` reports name "Dai Token", symbol DAI, 18 decimals. ✅ read from the chain with `eth_call`, 2026-11-17. ⚠️ An impostor could copy name and symbol: confirm BscScan labels it Binance-Peg DAI before any DAI-on-BSC payout code uses it.
- Payment check order: the watcher reads the chain first, then decides expiry, so a failed chain lookup never expires an invoice. Whether a payment is on time is decided by its first-seen time (see "First-seen times and the on-time rule"), not by whether it is there at the expiry check. ✅ `tests/invoice/watcher-pass.test.ts` (49/49), 2026-11-18.
- Underpaid tolerance: 0–5%, at most 2 decimals, stored on the invoice as `underpaid`. A payment is accepted when it is at least the amount less the tolerance, rounded up (`src/invoice/payment-rules.ts`). ✅ same run, plus `tests/routes/invoice-create-addresses.test.ts`.
- An invoice that expires with some money received gets `outcome: "partially_paid"`. That money is then sent on by refund routing, and the outcome stays `partially_paid`. ✅ same run, and `tests/invoice/refund-routing.test.ts` (37/37), 2026-11-18.
- Fee rule F1: every chain's payout splits the deposit with `splitPayout` (`src/money/payout-split.ts`). Platform fee = ceil(received × fee rate); merchant = received − platform fee − network cost. If that leaves the merchant 0 or less, it answers "too small to forward" (undefined) and the payout waits. A chain can still refuse a positive share below its own dust limit (BTC, LTC) or rent minimum (SOL). Before 2026-11-18 the fee was taken on received − network cost. ✅ `tests/money/payout-split.test.ts`, run 10/10, 2026-11-18.
- Payer-pays mode (`fee_paid_by_payer: true` at invoice creation, default false). The payer is asked for asked = ceil((invoice amount + estimated network cost) / (1 − fee rate)) (`payerPaysAskedAmount` in `src/money/payout-split.ts`). Paying exactly that leaves the merchant exactly the invoice amount when the real network cost equals the estimate; one unit less leaves less. ✅ `tests/money/payout-split.test.ts` (table and property tests at 0%, 0.5% and 5%), run 18/18, 2026-11-18.
  - The invoice stores both: `amount` (the invoice's crypto amount) and `asked_amount` (what the payer must send; equal to `amount` when the merchant pays). Fixed-coin invoices set it at creation; merchant's-list invoices set it when the payer picks a coin. The payer's page shows the asked amount; the merchant view (`GET /invoices/:id`), the creation response and the webhook show both, plus `feePaidByPayer`. ✅ `tests/routes/payer-pays.test.ts` (12/12) and `tests/webhooks/webhook-pass.test.ts` (11/11), 2026-11-18.
  - Invoices made before 2026-11-18 have no `asked_amount`; `askedAmount()` in `src/invoice/payment-rules.ts` reads them as asking for `amount`. ✅ `tests/invoice/payment-rules.test.ts` (6/6), 2026-11-18.
  - "Paid" and the underpaid tolerance are checked against the asked amount, and so are the BTC and TON payout minimums (all through `acceptedPaymentAmount`). A difference between the estimated and the real network cost is the merchant's: it falls out of F1 at payout. ✅ `tests/invoice/watcher-pass.test.ts` (25/25), 2026-11-18, with a fake payout port that splits by F1; the real BTC and TON payouts are not run with a payer-pays invoice.
  - The estimate is the `estimateNetworkCost` port in `AppDeps` (`src/app.ts`); the real one (`src/invoice/network-cost.ts`) asks the coin's chain adapter (`estimateNetworkCost`). BTC: Blockbook's 2-block fee rate (the one the BTC payout uses) × 244 bytes (one P2PKH input, two outputs of the widest standard script, 34 bytes). TON: the fixed 5,000,000-nanoton fee budget every TON payout charges, so a TON merchant gets exactly the invoice amount. A coin with no adapter answers "unsupported", and payer-pays is refused with `409 PAYER_PAYS_NOT_SUPPORTED`; an unavailable estimate gives `503 NETWORK_FEE_UNAVAILABLE`. ✅ `tests/invoice/network-cost.test.ts` (4/4, stubbed fetch), 2026-11-18. ⚠️ The Blockbook `estimatefee` reply format is the one the existing code assumes; no recorded response checks it.
  - A BTC payment in two parts makes a two-input payout, which costs about 148 bytes × fee rate more than the estimate; the merchant bears it. ✅ follows from the size formula in `src/transactions/btc.ts`.
  - The merchant's fee rate is copied onto the invoice at creation (`fee_rate`), for both modes; the payer-pays amount (also at a later coin choice) and the payout use it, so a later change of the merchant's rate can't change an open invoice. Invoices made before 2026-11-18 have `fee_rate: ""` and use the merchant's rate at payout time. ✅ `tests/invoice/watcher-pass.test.ts` (49/49) and `tests/routes/payer-pays.test.ts` (13/13), 2026-11-18.
  - LTC and SOL payouts still refuse payer-pays invoices. They can't be deposited today. ✅ seen in `src/transactions/ltc.ts` and `src/transactions/sol.ts`.
- SOL token payouts: the gas wallet pays the SOL network fee, so that cost is not taken from the merchant's share (`planTokenPayout` in `src/transactions/sol.ts` passes a network cost of 0). This breaks "all network costs come out of the merchant's share". ⚠️ seen in code; for the gas top-up ticket.
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
  - **Request:** `POST` with `content-type: application/json`, `x-webhook-timestamp: <unix seconds>`, and `x-webhook-signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`. The body is `{event:"invoice.status_changed", eventId, invoiceId, status, outcome, crypto, toCrypto, amount, askedAmount, feePaidByPayer, amountFiat, paidAmount, platformFee, networkFee, merchantAmount, txids:{in,out,platformOut}, occurredAt}`. Merchants should dedupe by `eventId`.
  - **Outcome changes** that come without a status change (too small to forward, held for manual handling, back to none after a forward) are events too: `event:"invoice.outcome_changed"`, same body, id `<invoiceId>:outcome:<outcome_version>`. The watcher adds 1 to `outcome_version` for each such change, so an outcome that comes back gets a new id. An outcome that changes with the status (expired + partially paid) rides on the status event. ✅ `tests/webhooks/webhook-pass.test.ts` (16/16), 2026-11-18.
  - **Refund routes**, once paid: `event:"invoice.refund_routed"`, id `<invoiceId>:refund_route:<n>`, body `{event, eventId, invoiceId, status, outcome, crypto, refundRoute:{number, destination, destinationSource ("refund_address" or "payout_address"), amount, platformFee, networkFee, txids, payments:[{txid, amount, onTime}]}, occurredAt}`. ✅ same run.
  - **Retries:** after 1 min, 5 min, 30 min and 2 h; the 5th failure marks the event failed. A redirect counts as a failure and is never followed.
  - **Destinations:** https only, and every address the name resolves to must be public (no loopback, private, link-local or metadata ranges). ⚠️ The name is resolved again when the request is sent, so DNS rebinding is not covered.
  - **Secret:** `whsec_…`, shown once when the first webhook URL is set; `POST /settings/webhook-secret` with a TOTP code replaces it. It is stored sealed (`webhook-secret`), because it is needed to sign.
- Payer's page, public and keyed by the invoice's random UUID: `GET /pay/:id`, `POST /pay/:id/choose {crypto}` (once, before expiry), and `POST /pay/:id/cancel` (only while status is `waiting`, `paid_amount` is `"0"` and the chain shows no payment; see "Cancel race"). It never shows the merchant's id or payout addresses. ✅ `tests/routes/pay-page.test.ts`, run 13/13, 2026-11-17; the chain check: `tests/routes/invoice-cancel.test.ts`, 2026-11-18.
- Merchant cancel: `POST /dashboard/invoices/:id/cancel`, session only (an API key gets 401). Same rule and answers as the payer's cancel: `200`, `409 CANNOT_CANCEL`, `503 CHAIN_UNAVAILABLE`; another merchant's invoice gets `404`. ✅ `tests/routes/invoice-cancel.test.ts` (10/10), 2026-11-18.
- `createApp({ chains })` lets tests replace the chain registry the two cancels ask. Invoice creation and the payer's coin choice still use the real registry (`src/chains/registry.ts`). ✅ seen in `src/app.ts`.
- `mode: "merchant_list"` invoices start with no deposit address, `amount: "0"` and `offered_coins`. Offered coins are the merchant's valid payout coins that have a chain adapter in `src/chains/registry.ts` (only `btc` and `ton` today), so they can be detected and paid out directly. Choosing a coin locks its price and creates the deposit; the invoice timer still runs from creation. The watcher expires invoices where no coin was picked in time. ✅ same run, plus `tests/invoice/watcher-pass.test.ts`.
- A deposit address always comes with its key: the model requires `private.private_key` whenever `address` is set, unless `subaddress_index` is (room for XMR, ticket 23). ✅ seen in `src/database/invoices.model.ts`.
- `createApp({ getPrice })` lets tests inject prices; production uses the exchange prices in `src/invoice/price.function.ts`. ✅ seen in `src/app.ts`.
- The watcher, the BTC payout and the TON payout all use one minimum, `acceptedPaymentAmount`: the asked amount less the tolerance (since 2026-11-18; before, the invoice amount). Before 2026-11-17 the payouts waited for the full amount, so an invoice confirmed within tolerance never paid out. ✅ `tests/invoice/payment-rules.test.ts`. The watcher hands it to the adapter as `minimumAmount`, and the payout waits below it: ✅ `tests/chains/ton-adapter.test.ts` (emulator) and `tests/chains/btc-adapter.test.ts` (stubbed Blockbook), 2026-11-18.
- Fixed-coin invoices take any deposit coin with a chain adapter (BTC and TON since 2026-11-18). A `crypto` with no adapter gets `409 DEPOSIT_COIN_NOT_SUPPORTED` instead of quietly becoming a BTC invoice. ✅ `tests/routes/pay-page.test.ts` (16/16), 2026-11-18.
- **No database indexes are ever created.** Every model has `autoIndex: false`, and nothing calls `createIndexes`. The unique indexes on `invoice_id`, `account_hash`, `api_key_hash`, `recovery_public_key`, `challengeHash` and `eventId`, and the TTL indexes on sessions and login challenges, exist only in the schemas. Code that relies on a duplicate-key error (error 11000) never gets one. ✅ checked with grep, 2026-11-17.
- First-seen times and the on-time rule (replaces "R1"). Each pass records the chain's current list of payments in `payments[]` (`txid`, `amount`, `first_seen_at`, `confirmations`, `on_time`). ✅ `tests/invoice/watcher-pass.test.ts` (49/49), 2026-11-18.
  - `first_seen_at` is the earliest of: the time of the first pass that listed the payment (`ports.now()`), the provider's time for it (`seenAt`), and the value stored by an earlier pass. It never moves later.
  - `on_time` means `first_seen_at` is before the expiry (`timestamps.waiting` + lifetime). A payment first seen exactly at the expiry is late. So is any payment first recorded after the invoice closed (see "Refund routing and the 7-day watch").
  - The status, `paid_amount` and the `partially_paid` outcome count only on-time payments. Late payments are recorded with `on_time: false`, change none of these, and are sent on by refund routing.
  - A payment the chain no longer lists (replaced before it confirmed) is dropped from `payments[]`.
  - `tx.in` is the txid of the earliest payment.
  - Limits ⚠️:
    - The provider's time is trusted. BTC gives Blockbook's `blockTime` and TON the transaction's chain time, so outages and the 15 s between passes no longer decide on-time for these coins. For a provider with no time, a payment that lands in the last 15 s before expiry, or during a lookup outage, is judged by when the watcher first lists it: late.
    - A BTC block's timestamp can be off by up to about 2 hours. A payment the provider never saw in its mempool is judged by its block's timestamp.
    - Blockbook's `blockTime` for a mempool transaction is the time that node first saw it. ⚠️ inferred from the recorded fixture (mempool transactions, `blockHeight: -1`, carry a `blockTime`); not checked against Blockbook's docs.
    - Invoices still open when this is deployed have no stored first-seen times. A BTC payment that was in the mempool before expiry but was mined after it, with a block time after the expiry, will be judged late. Deploy while no invoice is `underpaid` or `confirming`, or migrate those first.
    - A payment the watcher first lists after the invoice closed is recorded as late, whatever its provider time, and routed: it can no longer count toward the invoice. ✅ `tests/invoice/refund-routing.test.ts` ("records late money that the merchant payout swept…"), 2026-11-18.
- Cancel race (closed 2026-11-18): a cancel, by the merchant or the payer, now asks the chain through the adapter at cancel time, not only the stored `paid_amount`. A failed lookup refuses the cancel (`503 CHAIN_UNAVAILABLE`). A payment the provider does not list yet at that moment, or one landing between the check and the write, reaches a cancelled invoice: the 7-day watch records it and routes it. ✅ `tests/routes/invoice-cancel.test.ts` (10/10), 2026-11-18.
- Merchants created before 2026-11-17 keep `merchant_fee: "0.005"`. Only new merchants get 5%. ⚠️ the owner decides whether to migrate them.
- `required_confirmations` is still 1 for every coin. The approved per-chain numbers wait for a check against each chain's docs. ✅ seen in `cryptos.json`.
- TON chain data comes from the deposit's transactions, not its balance (`getTonPayments` in `src/transactions/ton.ts`). ✅ `tests/chains/ton-adapter.test.ts` (@ton/sandbox, 14/14), 2026-11-18.
  - A payment is the value one transaction credited and kept.
  - A bounceable payment the code-less deposit sent back is not a payment.
  - Each payment has 1 confirmation (TON has no reorgs) and `seenAt` = the transaction's chain time.
  - The list is refused (`undefined`) when it has 100 or more transactions, or when the balance is above everything listed as received (a missing payment).
  - ⚠️ That the API's `getTransactions` allows `limit=100` is unverified. The balance check catches a shorter page before the payout.
- Because TON payments are the credited amounts, the watcher no longer allows TON's storage-fee shortfall: a TON invoice is paid at exactly the asked amount less the tolerance. ✅ `tests/invoice/watcher-pass.test.ts`. The payout still waits only for `minimumAmount` less the 60-minute allowance (75 nanoton, `tonMinimumPayment`). ⚠️ That the credit phase carries the full value while the storage fee comes from the balance is from TON's transaction phases. The emulator charged no storage fee at all (0 after 30 simulated days), so no test shows it.
- The TON payout runs on an injectable `TonApi` (NOWNodes in production). The adapter tests answer it from the emulator in the toncenter v2 shapes the code reads (`getAddressInformation`, `getWalletInformation`, `getTransactions`, `sendBoc`). ✅ same run. ⚠️ Those shapes are the ones the code already assumed; no recorded NOWNodes reply checks them.
- On the emulator, the TON adapter: ✅ same run.
  - saves before sending;
  - re-sends the same message while it can land;
  - rebuilds an expired message with the same seqno (the old one is then refused);
  - proves the exact amount non-bounceable;
  - never pays twice when called again.
- BTC adapter: there is no regtest node yet (ticket 16). With stubbed Blockbook replies and real bitcore signing, these are shown: ✅ `tests/chains/btc-adapter.test.ts` (11/11), 2026-11-18.
  - it saves before broadcasting, and a lost save broadcasts nothing;
  - it re-sends the saved hex;
  - the proof is read from the confirmed transaction's own outputs;
  - a 0% fee sends no platform output;
  - two payments become a two-input transaction.
  ⚠️ Not shown: that a node accepts the transaction, or the real `sendtx` and `tx/{txid}` reply formats.
- A BTC payout that stops now records why in `review_reason`, with the deposit address. Before 2026-11-18 it only logged it. ✅ `tests/chains/btc-adapter.test.ts`.
- Legacy swaps (BTC → `usdceth`) are followed with `updateSwapStatus` in `src/swap/near.ts` for both BTC and TON. The older copy in `src/transactions/btc.ts` is no longer called. Status changes are the same; the review notes are the newer wording. ✅ seen in code.

## Refund routing and the 7-day watch

Code: `src/invoice/closed-watch.ts` (the watch and routing), `src/invoice/payment-ledger.ts` (which payout carried which payment), `src/invoice/cancel.ts`. Tests: `tests/invoice/refund-routing.test.ts` (37/37, fake chain that sweeps the deposit), `tests/routes/invoice-cancel.test.ts` (10/10), `tests/webhooks/webhook-pass.test.ts` (16/16), `tests/chains/ton-adapter.test.ts` (15/15, emulator), all 2026-11-18.

- **The watch.** When an invoice closes, it stores `watch_until` = the close time + 7 days. The close sites: expiry (both kinds of invoice), the two cancels, the merchant payout completing, and a legacy NEAR swap completing (`src/swap/near.ts`). ✅ (the NEAR site: seen in code only).
  - A closed invoice (`expired`, `cancelled`, `completed`) is looked at from the pass after it closed, at most every 5 minutes; a refund route in flight is followed every pass. ⚠️ The 5 minutes is my default: each look is one chain lookup, so the load grows with a week of closed invoices. ✅ the timing itself.
  - Each look records the chain's payments in `payments[]`. A payment first seen after `watch_until` is not recorded.
  - `failed` invoices are not watched: a person handles that deposit.
  - Invoices closed before this was deployed have `watch_until: null` and are never watched. ✅
- **What routes.** Every payment no payout has carried yet, once it has the chain's `requiredConfirmations`, whatever the reason it is there:
  - partial money at expiry (outcome `partially_paid`, which stays);
  - money after a cancel;
  - money after completion;
  - late money after expiry.
  ✅ one table row each.
- **Where it goes.** The merchant's refund address for the deposit asset; else their payout address for it; else nothing is sent and the outcome is `held_for_manual_handling`, with a `review_reason` naming the amount, the payments and the deposit address. An address the adapter's `isValidAddress` refuses counts as missing. Addresses are read at routing time: if the merchant sets one while the watch runs, held money is forwarded. ✅
  - Ticket 15 adds the spec's swap-to-receive-coin step in `refundDestination`, before "held".
- **Fees.** F1 at the invoice's `fee_rate`, through the adapter, like a merchant payout (`destinationKind: "refund_route"`). The table checks exact amounts, e.g. 50,000 sat at 5% with a 1,000 network cost gives 46,500 to the refund address and 2,500 to the platform. ✅
- **Too small to forward.** If `splitPayout` with the adapter's `estimateNetworkCost` leaves nothing, the adapter is not called. If the estimate is unavailable, the adapter is asked. If the adapter answers `too_small` (its dust or rent limit), nothing is sent either. Both set `outcome: "too_small_to_forward"`, and the money stays at the deposit. A top-up inside the watch is forwarded together with it, and the outcome goes back. At the watch's end it stays `too_small_to_forward`. ✅
- **One route at a time, each with its own checkpoint.** `refund_routes[]` holds one element per route, numbered from 1: `destination`, `source`, `state` (`processing`, `paid`, `failed`), `raw` (its checkpoint, not selected by default), `swept`, fees, times, and `notified` for the webhook.
  - The first checkpoint save pushes the element. That push is compare-and-set on the route number and on `watch_version`, so of two overlapping runs only one saves.
  - Later saves are compare-and-set on the route's own `raw`.
  - A route never sees the merchant payout's `tx.raw` or an earlier route's checkpoint.
  - Its planned transfers go to `transfers[]` with `payout: n`.
  ✅ the crash test (killed after the save: the next pass hands the saved checkpoint back, and only one broadcast happens), the race test, and "routes a second late payment in its own route".
- **A failed route** keeps the adapter's where-the-money-is message in `review_reason`, marks its planned transfers `failed`, sets `held_for_manual_handling`, and ends the watch (`watch_done`). The status does not change. ✅
- **A route pending 24 hours** after its save gets a review note, as a merchant payout does. ✅
- **`minimumAmount: 1` for refund routes**: forward whatever the deposit holds. The merchant payout's minimum minus 75 nanoton would never be met by TON money held for days. ✅ the route asks for 1 (fake chain with a storage fee).
  - On the emulator, a second payout from a TON deposit that already paid the merchant works: it reached the refund address with the exact F1 amount, non-bounceable, and the merchant was not paid again. ✅ `tests/chains/ton-adapter.test.ts`.
  - There the deposit held about 36,400 nanoton less than the 1 TON credited. Once the deposit wallet is deployed (after its first payout), receiving runs its code and the compute fee comes out of the balance. ✅ same test: refund amount 944,965,419 nanoton.
- **What each payout carried** (`payments[].payout`: 0 = the merchant payout, n = route n; absent = still at the deposit). A payout sweeps the whole deposit, so it carried whatever was there, not a list the watcher chose.
  - After a payout is proven, the watcher gives it the payments in chain order (most confirmations, then first seen) while its swept amount (destination + platform fee + network cost, from the saved plan) is not used up. A payment that only partly fits still counts, because a storage or compute fee can take a little of it. An unconfirmed payment can't have been swept.
  - So late money that reached the deposit before the merchant payout is recorded as carried by it (to the merchant's payout address), and is never routed again. ✅ "records late money that the merchant payout swept…", including a 3-unit storage shortfall.
  - ⚠️ Not shown: BTC payments confirming out of their first-seen order. The ordering by confirmations is meant to cover it.
- **When the watch ends.** After `watch_until`, payments first seen before it can still be routed for 24 hours (`ROUTE_GRACE_MS`), e.g. waiting for confirmations. A route already saved is followed until it lands or fails. Then `watch_done` is set. Anything no payout carried becomes `held_for_manual_handling` with a review note, except money that is `too_small_to_forward`. ✅
- **Money that arrives after `watch_until`** is not recorded, routed or announced. It stays at the deposit address, whose sealed key stays in the database (story 78), so a person can move it with the key. There is no tool for that yet (see "Before TON goes live" in requirements). ✅ not recorded (table rows "after the 7 days"); ⚠️ no recovery tool.
- ⚠️ **TON late money after signing.** A TON payout's second message sends everything left to the platform (mode 128). Money that lands between signing and landing goes to the platform wallet, and the adapter's `Late payment:` note says so. The watcher then sees that payment as not carried and tries a route, which waits on an empty deposit. When the watch ends, the payment is held with a "should still be at deposit address" note. The earlier `Late payment:` note is kept beside it, and it says where the money really is. Seen in code; not tested.
- **Deploy rule.** Invoices still open at deploy have no stored first-seen times (see "First-seen times"): deploy while none is `underpaid` or `confirming`. Invoices closed before the deploy are never watched (`watch_until: null`), so money reaching them later is not recorded. Invoices closed after the deploy that were created before it have no `watch_version`; the watch treats a missing one as 0. ✅ the test invoices are inserted without it.

## Pitfalls
- Tests call `deleteMany` on the database they connect to. `npm test` is now guarded (branch `launch-groundwork`): it refuses to start unless `MONGODB_DATABASE` ends in `_test`, never reads `.env`, and `connectToMongoDb` refuses a non-`_test` name whenever `NODE_ENV=test`. ✅ `tests/infrastructure/test-database-guard.test.ts`, and a full `npm test` run (87/87) on a throwaway `merchant_test` database, 2026-11-17.
- `toObject()` on an invoice document hands back Buffer fields (the sealed deposit key) as BSON `Binary`, and `Buffer.from(Binary)` is an empty buffer. Read the key from the document itself, as `src/invoice/closed-watch.ts` and the merchant payout do. ✅ `tests/invoice/refund-routing.test.ts` ("is the deposit's own sealed key…") failed before the fix with "Invalid initialization vector"; a scratch check printed `Binary`, 0 bytes, 2026-11-18.
- Running a single test file directly with `node --test` skips the npm `pretest` check. Add `--import ./tests/setup/test-guard.ts`, as in the `test` script. ✅ seen in `package.json`.
- `npm run watch:once` runs `src/invoices/run-watcher-once.ts`, which does not exist (the folder is `src/invoice/`, and it has no such file). ⚠️ seen 2026-11-18; not fixed.
- 28 old files (27 tests that import deleted modules or functions, plus their helper) live in `legacy-tests/`, outside the test run. ✅ moved with `git mv` on 2026-11-17.
