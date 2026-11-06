# Backend milestone B1

The gateway now requires PostgreSQL 16 or newer. All operational collections, campaign statistics,
uploads, moderator accounts, sessions and moderation decisions persist in PostgreSQL. The original
JSON adapters remain only for existing isolated domain tests; `createGateway()` never writes JSON.
Browser guest tokens and the advertisement request/response shapes are unchanged. Browser-only demo
balances are not server accounts and are outside B1; the two-phone ledger is a later milestone.

## Install and cut over

Run commands from the repository root using Node 22+:

```sh
npm ci
npm ci --prefix server
```

1. Stop the old gateway, including Vite's embedded gateway. Back up `DATA_DIR` including `uploads/`
   and take a PostgreSQL backup if the target already contains data. Keep the backup offline.
2. Set `DATABASE_URL` to a dedicated database owned by the backend operator. For local development,
   `POSTGRES_PASSWORD=<local-password> docker compose -f server/compose.yaml up -d` starts PostgreSQL
   on loopback. Use a real password in the URL. No container or deployment is launched automatically.
3. Set `DATA_DIR` to the **absolute** directory containing the old JSON files, then run:

   ```sh
   node server/manage.js migrate
   node server/manage.js import
   ```

4. Provision individual moderator accounts as described below. Unset provisioning passwords.
5. Start with `npm start` (or `npm run dev` for the existing Vite gateway), then verify
   `GET /api/health`, submit/review an ad, complete a DEMO rental and reconnect a world client.
   Keep legacy files and uploads until backup retention permits removing them.

Migrations are ordered, additive SQL files, protected by a database transaction and advisory lock.
Each applied migration has a checksum; editing an applied file fails verification. Add another file
for future changes. The migration runner rolls back all pending DDL on failure. JSON import checks
all available source arrays, rejects duplicate IDs and existing-record conflicts, and imports every
source in one transaction. `payments`, `shops`, `orders`, `invoices`, `threads`, `posts`, `ads`, `mutes`
and `accounts` records retain every field, including historical statistics. Referenced upload bytes
are copied into PostgreSQL under their existing names. Files are never deleted or rewritten.
The importer records source checksums: an identical rerun is a no-op; changed sources require manual
reconciliation and are never silently overwritten. Startup refuses missing/modified migrations or
unimported/changed legacy sources, including through Vite.

To recover from a failed migration/import, fix the reported input or connection issue and rerun;
there is no partial import to undo. For a rollback after cutover, stop all writers and restore the
database backup. Do not restart the JSON gateway against stale files after accepting new writes.
Use provider backups/PITR and regularly test restoration. Images now belong to the database backup.

## Moderator accounts

`MODERATOR_KEY` has no effect. Account registration is an operator command, never a public API.
Set these temporary environment variables in your shell or secret manager, then run
`node server/manage.js account`:

| Variable | Meaning |
| --- | --- |
| `OMEN_ACCOUNT_USERNAME` | 3–64 lowercase letters, digits, `.`, `_`, `-` |
| `OMEN_ACCOUNT_PASSWORD` | 12–256 characters; stored using salted scrypt |
| `OMEN_ACCOUNT_ROLE` | `reviewer`, `moderator` (default), or `admin` |
| `OMEN_ACCOUNT_PLAYER_ID` | Optional public 24-hex guest ID; bind the account if this moderator also advertises |
| `OMEN_ACCOUNT_DISABLED` | `1` disables the account; default `0` |

Reprovisioning an existing username rotates its password, replaces role/player binding/disabled
status and revokes all its sessions. Supply the existing player binding when rotating a password.
The account's bound player identity cannot be bypassed by omitting or changing a request header.
Guest identity proves possession of a browser secret, not that two different secrets are different
humans. World ID and stronger identity linking are outside this advertising milestone.

| Role | Permissions |
| --- | --- |
| reviewer | View review queue, reports, statistics, and protected images |
| moderator | Reviewer permissions plus approve/reject, hide/unhide and takedown |
| admin | Moderator permissions plus delete content and mute/unmute players |

Sessions last eight hours, use random 256-bit bearer credentials, and store only SHA-256 token hashes.
Expired, revoked and disabled-account sessions fail immediately. Login throttling persists in the
database: five failed attempts per source IP or username in fifteen minutes. Moderator mutations
and their account-attributed audit records commit together. A failed mutation creates no audit entry.

## API contract

All requests/responses use JSON. Successful responses keep HTTP 200. Errors use
`{ "error": "stable_code", "message": "readable explanation" }` with 400/401/403/404/409/413/415/429
or 5xx as appropriate. Guest identity uses `x-omen-token: <64 lowercase hex browser secret>`.
Public player IDs are never accepted as authorization credentials.

| Method and path | Request / authorization | Response |
| --- | --- | --- |
| POST `/api/mod/login` | `{username,password}` | `{token,expiresIn:28800,account:{id,username,role,playerId}}`; HttpOnly, SameSite=Strict session cookie |
| GET `/api/mod/me` | Moderator session | `{account}` |
| POST `/api/mod/logout` | Session; empty object | `{ok:true}`; revokes session and clears cookie |
| GET `/api/mod/queue` | Reviewer or higher | Existing `{pendingAds,liveAds,decided,reported,muted}` shape |
| POST `/api/mod` | Permission from role table; existing `{action,kind?,id?,playerId?,reason?}` | Existing ad card or `{ok:true}` |
| GET `/api/ads` | Public | `{ads:[adCard]}`; only visible, unexpired live campaigns; no counters or author IDs |
| GET `/api/ads/boards` | Public | `{boards:[{id,label,slots,free,waiting,nextFreeAt}]}` |
| GET `/api/ads/mine` | Guest token | `{ads:[adCardWithStats]}`; this guest's campaigns only |
| POST `/api/ads` | Guest token; `{boardId,brand,title,text?,shopId?,link?,days,image?,name?}` | Existing pending ad card; up to 1 MiB JSON |
| POST `/api/ads/:id/rent` | Owning guest; `{token:"DEMO"}` or existing configured testnet `USDT` | `{ad,payment}`; concurrent/repeated calls return the same active payment |
| POST `/api/ads/:id/seen` | Guest token; `{}` | `{counted,reason?}` |
| POST `/api/ads/:id/click` | Guest token; `{kind:"details"\|"shop"\|"link"}` | `{counted,reason?}` |
| GET/POST `/api/payments/:id[/risk\|authorize\|submit\|cancel\|relay]` | Owning guest required for ad rentals | Existing payment response; strangers receive 404 |
| GET/HEAD `/uploads/:name` | Public for visible live ads; otherwise owner or moderator session | PNG/JPEG bytes; private/no-store, nosniff, sandbox CSP; unauthorized and missing both 404 |

Moderator authentication accepts `Authorization: Bearer <session-token>`, the session cookie, or
`x-mod-key: <session-token>`. The last form preserves the existing moderator console transport;
it does **not** accept the former shared key. Until Claude adds a login form, log in via the API and
paste the returned expiring token into the existing console's key field. Same-origin login cookies
also authorize its image previews. No frontend or console UI files changed for B1.

Ad cards retain `id,boardId,brand,title,text,link,shop,image,authorName,status,reason,days,expiresAt,rented`.
Owner views retain `createdAt,approvedAt,endedAt,stats`, where stats contain
`impressions,uniqueViewers,clicks,uniqueClickers,ctr`. No raw viewer lists are exposed.
Brand/headline moderation and existing 1/3/7-day terms, board capacity and slot reservations remain.
One-day approvals go live immediately; longer terms await rent, and unpaid reservations expire after
48 hours. Impressions deduplicate per guest/ad for five minutes; each click kind for thirty seconds.
Deduplication timestamps persist across restarts. Unique viewer/clicker arrays keep the existing
5,000-person ceiling; counters continue counting valid events after that ceiling. These remain
client-reported engagement metrics, not independently verified ad-delivery measurements.

New images must fully decode as PNG/JPEG, be 64–2048 px on each side, and fit 700 KiB before and after
server re-encoding. Metadata and trailing payloads are discarded. Pending/rejected/hidden/expired/
taken-down images are not public. Authenticated advertiser API calls set an HttpOnly media cookie,
scoped to `/uploads/`, so existing `<img>` elements can preview private campaigns without header changes.

## WebSockets and transaction boundaries

Existing Socket.IO `/world` events remain `ads:update` (public card list), `ad:update` (owner card),
`mod:queue` (pending count), and forum/shop/order events. Notifications are captured during the
transaction and emitted **after commit**. Rollbacks emit nothing. Private player events require a
valid guest token during `join`; knowing a public `resume` ID never subscribes to private events.
Clients should fetch `/api/ads` on reconnect, as they already do; socket delivery is best effort
and is not a durable notification inbox.

The existing synchronous domain model runs over a fresh transaction-local PostgreSQL snapshot.
One advisory transaction lock serializes economy operations across database connections, preventing
slot overbooking, lost counters, duplicate active rentals and cross-collection partial commits.
Database primary/unique constraints additionally protect IDs and claimed payment hashes.
This deliberately bounds B1 to **one gateway instance**: world rooms and event fanout are local.
The lock and snapshot load are a throughput ceiling, especially during external inference/chain waits;
measure before scaling, then move to per-board/per-account SQL operations plus a shared Socket.IO
adapter/outbox. Do not increase `numInstances` without those changes. Lock timeout is 10 seconds,
statement timeout 30 seconds, pool size eight; database errors roll back and return 5xx.

Production blockchain submission/reconciliation and the two-phone ledger require their own
milestone; B1 verification uses DEMO payments and existing mocked chain tests only.

## Environment and deployment

| Variable | Required/default |
| --- | --- |
| `DATABASE_URL` | Required. Dedicated PostgreSQL URL. Hosted connections should use `sslmode=verify-full` and trusted CA configuration; do not disable certificate verification. |
| `DATA_DIR` | Legacy import source; defaults to repository `server/data`. Prefer an absolute path. No new JSON/upload files are written here. |
| `NODE_ENV` | Set `production` behind HTTPS; adds Secure to session/media cookies. |
| `PORT` | `8787` |
| `ALLOWED_ORIGIN` | Empty for same-origin. Set the exact frontend origin for split hosting; authorization and guest headers are allowed by preflight. Bearer sessions work cross-origin; private image cookies assume same-origin hosting. |
| `TRUST_PROXY` | Set `1` only behind a proxy that overwrites forwarded client-IP headers. |
| `BILLBOARD_PAYOUT` | Optional existing testnet payout wallet. Leave empty for DEMO-only advertising rental. |
| `CHECKOUT_ADDRESS`, `WHITECHAIN_RPC`, `MIN_CONFIRMATIONS` | Existing testnet checkout configuration; see root `.env.example`. |
| `RELAYER_PRIVATE_KEY`, `RELAYER_MAX_PER_HOUR`, `RELAYER_MIN_WBT` | Existing optional testnet relayer. No key required for B1. |
| `ZG_*`, `ANTHROPIC_API_KEY`, `RATE_URL`, `FALLBACK_USDT_INR`, `COINGECKO_API_KEY` | Existing optional inference/rates; do not expose private keys to the browser. |
| `MERCHANT_KEYS`, `WEBHOOKS`, `WEBHOOK_SECRET` | Existing merchant access/notification configuration. |
| `TEST_DATABASE_URL` | Required only for backend integration tests. Use a disposable database with CREATE SCHEMA permission. Never point it at production. |

Docker installs the separate locked server dependencies. The Render blueprint retains one instance
and requires an operator-supplied `DATABASE_URL`; provision PostgreSQL and run migrate/import before
starting the service. Keep credentials in the hosting secret manager. The existing disk is useful
for legacy import/backup retention but is not the new operational store. This change does not deploy.

## Verification

```sh
# Set TEST_DATABASE_URL to a disposable local PostgreSQL database first.
npm --prefix server test
npm test
```

Integration tests create random temporary schemas, use real PostgreSQL transactions and two pools,
and drop only their own schemas on completion. They cover DDL rollback/checksums, idempotent import,
field-for-field preservation of the local legacy records if present, authentication/roles,
self-review denial, login throttling, concurrent approvals/counters/rentals, private payment access,
image decoding/access control, restart persistence, rollback suppression and actual WebSocket events.
The repository suite retains existing commerce/payment/forum/Arkiv coverage. Tests never sign or
submit blockchain transactions. CI uses a disposable PostgreSQL service.

Implementation references: [PostgreSQL advisory transaction locks](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS),
[node-postgres transactions](https://node-postgres.com/features/transactions),
[sharp input limits](https://sharp.pixelplumbing.com/api-constructor/).
