# COMMIT NOW — BACKEND MILESTONE B1

Verified locally on 2026-11-06 with Node 24.13.1 and PostgreSQL 16.13.

## Result

- PostgreSQL replaces operational JSON writes in the gateway, including campaigns, accounts,
  statistics, shared commerce records, payment history and image bytes.
- Transactional migrations and a non-destructive, idempotent import preserve legacy fields.
  The existing local JSON records were imported into isolated test schemas and compared field for
  field. Original files and the running application's data were not changed.
- Individual moderator accounts have salted passwords, expiring/revocable sessions, role checks,
  persisted login throttling, bound-player self-review protection and an account-attributed audit.
- Existing advertiser API shapes and WebSocket event shapes remain. Private images/payment records
  require owner or moderator authorization; public resume IDs cannot receive private socket events.
- Concurrent approvals cannot overbook boards; active rental creation is idempotent; engagement
  deduplication survives reconnects/restarts. Notifications escape only committed transactions.

## Checks

| Command/check | Result |
| --- | --- |
| `npm --prefix server test` with local disposable `TEST_DATABASE_URL` | 16 passed; 0 failed/skipped |
| `npm test` | 111 passed; 0 failed/skipped |
| `npm audit --prefix server --omit=dev --audit-level=high` | 0 vulnerabilities after upgrading sharp to 0.35.5 |
| `node --check` on gateway, database and auth modules | Passed |
| `git diff --check` | Passed |
| Temporary PostgreSQL schemas after integration tests | 0 remaining |

The tested workflow is guest submission → account-based moderation → optional DEMO rental →
authorization/submission → live ad → impressions → expiry/takedown, with actual WebSocket delivery.
Persistence is verified through independent database pools and a recreated gateway.
Migrations were tested for rollback, rerun safety, checksum enforcement, corrupt input and conflicts.
No blockchain transaction was signed or submitted. No live deployment was performed.

## Backend files for the manual commit

New files:

- `.github/workflows/backend-b1.yml`
- `server/.gitignore`
- `server/README.md`
- `server/B1-VERIFICATION.md`
- `server/auth.js`
- `server/compose.yaml`
- `server/manage.js`
- `server/migrations/001_economy.sql`
- `server/package.json`
- `server/package-lock.json`
- `server/postgres.js`
- `server/test/b1.test.js`

Modified files:

- `.dockerignore`
- `.env.example`
- `Dockerfile`
- `render.yaml`
- `server/commerce.js`
- `server/community.js`
- `server/config.js`
- `server/db.js`
- `server/images.js`
- `server/index.js`
- `server/main.js`
- `server/moderation.js`
- `server/realtime.js`
- `server/store.js`
- `test/community.test.js`

Other dirty/untracked frontend, venue, asset and documentation files belong to the concurrent
frontend work. They are not part of this backend change. Stage the listed paths explicitly.

## Before starting the migrated backend

Follow `server/README.md`: configure `DATABASE_URL`, stop the old JSON writer, back up legacy data,
run `node server/manage.js migrate`, run `node server/manage.js import`, then provision individual
moderator accounts. Keep one gateway instance. The existing moderator UI can use a login session
token in its existing key field; a login form is a frontend follow-up. API contracts, environment
variables, backup/cutover instructions and throughput limits are documented there.

Suggested commit message:

```text
feat(backend): harden advertising economy with PostgreSQL and moderator RBAC
```

B1 stops here. No commit, push, deployment or two-phone payment backend work was performed.
