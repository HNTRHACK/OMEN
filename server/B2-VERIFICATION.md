# COMMIT NOW — BACKEND B2

Verified locally on 2026-11-07 with Node 24.13.1 and PostgreSQL 16.13.
No staging, commit, push, deployment or application database cutover was performed.

## Recovered work and completed fixes

The interrupted session had already added the B2 SQL schema, integer rate/quote
service, customer funding, merchant credentials/recovery, settlement, receipts,
outbox, realtime namespace, gateway wiring and 17 proposed integration tests.
These files were continued in place. The first real database run exposed a syntax
error in the payment-validation trigger that prevented migration 003 from applying,
and a wrong rounding expectation in two tests. Those are fixed. Earlier applied
migrations 001 and 002 were not changed.

Additional fixes reject hostile browser socket origins and invalid timestamp cursors,
and order merchant credential checks/session issuance against access-code recovery.
The latter prevents an in-flight login from retaining an old-code session after
recovery revokes earlier sessions. Five additional integration tests cover these
cases, World ID settlement, deferred commit failures and notification isolation.
The original realtime test now checks live balances on both phones as well as receipts.

## Verified outcome

- Phone A uses a guest possession credential or existing World ID player session.
  Phone B has a distinct player owner and an independent authenticated merchant session.
- Customer registration funds 1,000,000 DEMO satoshis exactly once, including races.
  The customer reads a server-resolved receiving code, obtains an immutable INR/BTC
  quote and confirms it with a UUID v4 idempotency key.
- Settlement uses integer satoshis/paise, ordered account row locks and one PostgreSQL
  transaction. Customer debit, merchant credit, four double-entry postings, immutable
  receipt, audit and notification outbox commit atomically. Each asset sums to zero.
- Simultaneous retries, competing spends and independent pools cannot double debit,
  overdraw, lose merchant credits or reuse quotes/fixed requests. Expired/stale quotes,
  bad amounts, insufficient funds and unauthorized accounts cannot move value.
- Failure after debit and failure at deferred COMMIT roll back all payment state.
  Both phones receive no live confirmation/balance change from the failed transaction.
  The same key can retry safely while the quote remains valid.
- Both authenticated Socket.IO clients receive matching receipts and private balance
  changes. Unrelated customers receive no payment. Client socket packets cannot
  mutate balances. Revoked/expired sessions and hostile origins are rejected.
- Lost responses replay the original payment after reopening the database pool.
  Persisted history, pagination and reconnect reads recover matching receipts.
  Failed outbox publication remains pending and retries without running settlement.
- Every success/receipt is labelled **SIMULATED BTC → INR SETTLEMENT**. No Bitcoin,
  bank, UPI, Whitechain or Arkiv transaction is created by B2.

## Test results

| Command/check | Result |
| --- | --- |
| `npm.cmd --prefix server test` with disposable local `TEST_DATABASE_URL` | **54 passed**: 22 B2 + 16 B1 + 16 World ID; 0 failed/skipped/cancelled |
| `npm.cmd test` | **118 passed**; 0 failed/skipped/cancelled |
| `node --check` for every `server/*.js` and `server/test/*.js` | Passed |
| Backend `git diff --check` (tracked and new B2 files) | Passed |
| Temporary integration schemas after completion | 0 remaining |
| Hash comparison of pre-existing dirty venue/frontend/test files and proposed API doc | Unchanged |

The full integration run exercises real PostgreSQL transactions and actual HTTP and
Socket.IO connections, not an in-memory ledger. Provider HTTP replies and World ID
authentication evidence are test fixtures; World ID's existing RSA/OIDC verification
suite also passed. Expected injected database exceptions in test logs demonstrate
rollback cases and are not test failures. Existing advertising, commerce, mocked
Whitechain and Arkiv regression coverage passed.

Local ignored logs: `server/.test-postgres-b2-final.log` (54 integration tests),
`server/.test-postgres-b2-regression.log` (118 repository tests). Tests used the
existing loopback PostgreSQL test cluster on port 55432 and created/dropped their own
random schemas; no persistent application schema or legacy JSON record was modified.

## Frontend handoff and operational limits

Implemented contract: [CONTRACT-BTCINR.md](CONTRACT-BTCINR.md).
The existing [frontend proposal](../docs/contracts/btc-inr-frontend-requirements.md)
is preserved. Material amendments are documented: player-authenticated merchant
sign-up returning 201, optional HttpOnly merchant cookies, explicit recovery,
single-use fixed QR requests (`request_paid`), 1,000,000-satoshi initial balance,
₹10,000 cap, and synchronous confirmed version-1 receipts.

The flow was verified with independent HTTP/WebSocket clients representing two
devices. Physical-phone/browser QR and camera acceptance was not run: the proposal's
`pay.html`, `src/btcinr/` and `e2e/btcinr-phones.mjs` are absent from this checkout.
Those frontend files were not added or modified. Live CoinGecko availability and
production World ID login were not claimed or required for deterministic backend tests.

Before starting this backend, apply migration 003 using `node server/manage.js migrate`
against the intended database following the existing backup/cutover process in
[README.md](README.md). Optionally set `BTCINR_DEMO_INR_PER_BTC=5734210.55` for a
deterministic, explicitly labelled demo price; unset it for the CoinGecko provider.

Keep one gateway instance. Outbox acknowledgement means gateway publication, not
device acknowledgement. Socket delivery may repeat, and disconnected phones resync
balance/history rather than replaying a per-device inbox. There is no closed-app push.
There is no conversion to real funds or real settlement capability in this milestone.

## Exact backend file manifest for manual commit

Modified files (4):

- `.env.example`
- `server/README.md`
- `server/index.js`
- `server/realtime.js`

New files (7):

- `server/B2-VERIFICATION.md`
- `server/CONTRACT-BTCINR.md`
- `server/btcinr-rates.js`
- `server/btcinr-realtime.js`
- `server/btcinr.js`
- `server/migrations/003_btcinr_demo_ledger.sql`
- `server/test/btcinr.test.js`

Other dirty/untracked frontend, venue, reference and Blender files belong to separate
work and are excluded. In particular, the pre-existing proposed frontend API document
is not part of this backend manifest. Stage the eleven paths explicitly when ready.
No dependency manifest, World ID implementation, Whitechain, Arkiv, frontend, avatar
or Blender source file was edited by this B2 recovery.

Suggested commit message:

```text
feat(backend): complete simulated BTC-to-INR ledger and realtime receipts
```

COMMIT NOW — BACKEND B2. Implementation stops here for the user's manual commit.
