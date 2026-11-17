# merchant-v3 backend

Non-custodial crypto invoicing backend. This code moves real money: correctness beats speed.

Before starting, read:
- `docs/requirements.md` and `docs/domain.md` (this project)
- Shared domain knowledge: `/Users/leezh/Documents/Claudemd/domains/blockchain/general.md` and `/Users/leezh/Documents/Claudemd/domains/blockchain/ton.md`

Check `docs/decisions/` before changing anything a decision covers.

## Never do
- **Do not run `npm test`.** Some tests call `deleteMany` on the database named in `.env`, and some import files that no longer exist. Run single test files instead:
  `node --import tsx --test tests/<path>.test.ts`
- Do not read, edit or print `.env`. Tests set fake env values themselves.
- Do not send mainnet funds. Real-money runs are done by me.

## Checks before saying "done"
- `npx tsc --noEmit`, and report every error it prints.
- Run the test files for the area you changed, and paste the output.
- Money-path changes need a permanent test, not only a scratch script.

## Useful commands
- TON payout tests (emulator only, no database, no network):
  `node --import tsx --test tests/transactions/ton-payout.test.ts`
- Dev server: `npm run dev`
