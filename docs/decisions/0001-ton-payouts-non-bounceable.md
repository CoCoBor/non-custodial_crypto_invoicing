# 0001: Every TON payout message is non-bounceable

Status: accepted

## Context
"Completed" must mean both "our payout transaction succeeded" and "the merchant has the money" (see requirements). The first version checked the second part by looking up the merchant's own transactions (`findTonReceipt`). That added an API call per payout and could fail on busy wallets (more than 500 transactions to page through).

The only way sent money fails to arrive is a bounce, and bounces happened only because payouts to already-deployed wallets were sent bounceable.

## Options
1. Keep bounceable payouts and look up the merchant's receipt.
2. Send every payout message non-bounceable, so the chain itself guarantees the merchant keeps it.

## Choice
Option 2, for both the merchant message and the platform message (a bounced platform message would return the platform's share to the deposit address).

## Why
- Arrival becomes a guarantee of the chain, not something we look up.
- One fewer API call per payout, and no "receipt not found" failures.
- Tests prove it: a contract whose code always fails still keeps the exact amount.

## Trade-offs
- "Completed" can show a few seconds before the merchant's wallet app shows the money.
- No bounce protection if we pay a wrong address. Addresses are validated before sending.

## Guarded by
- `paidExactly` requires `bounce=false` on the merchant message.
- `tests/transactions/ton-payout.test.ts`: flipping payouts back to bounceable makes 4 tests fail.
