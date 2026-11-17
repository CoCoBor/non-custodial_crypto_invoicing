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
- A payout address is checked by its coin's chain (BTC, LTC, EVM for ETH/BSC, SOL, TON) in `src/assets/payout-address.ts`. Tron and Monero answer "not supported yet". ✅ `tests/routes/invoice-create-addresses.test.ts`.
- USDT on TON: jetton master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`, 6 decimals. 📄 docs.ton.org (WalletKit jettons).
- USDT on Tron: contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, 6 decimals. 📄 tron.network/usdt.
- DAI on BSC: contract `0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3` reports name "Dai Token", symbol DAI, 18 decimals. ✅ read from the chain with `eth_call`, 2026-11-17. ⚠️ An impostor could copy name and symbol: confirm BscScan labels it Binance-Peg DAI before any DAI-on-BSC payout code uses it.
- `required_confirmations` is still 1 for every coin. The approved per-chain numbers wait for a check against each chain's docs. ✅ seen in `cryptos.json`.

## Pitfalls
- Tests call `deleteMany` on the database they connect to. `npm test` is now guarded (branch `launch-groundwork`): it refuses to start unless `MONGODB_DATABASE` ends in `_test`, never reads `.env`, and `connectToMongoDb` refuses a non-`_test` name whenever `NODE_ENV=test`. ✅ `tests/infrastructure/test-database-guard.test.ts`, and a full `npm test` run (87/87) on a throwaway `merchant_test` database, 2026-11-17.
- Running a single test file directly with `node --test` skips the npm `pretest` check. Add `--import ./tests/setup/test-guard.ts`, as in the `test` script. ✅ seen in `package.json`.
- 28 old files (27 tests that import deleted modules or functions, plus their helper) live in `legacy-tests/`, outside the test run. ✅ moved with `git mv` on 2026-11-17.
