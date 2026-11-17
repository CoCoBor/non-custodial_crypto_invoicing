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

## Pitfalls
- `npm test` runs tests that call `deleteMany` on the database named in `.env`. ✅ seen in `tests/invoices/invoice-watcher.test.ts` and others.
