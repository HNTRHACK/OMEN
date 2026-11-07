# READY TO DEPLOY — operator runbook

Audit date: 2026-11-07 (IST). No commit, push, deployment, service provisioning or
funded transaction was performed. Public access is an operator action after this
checkpoint. This document contains environment names, not secret values.

## Current source and release gates

- Repository: `HNTRHACK/OMEN`; branch `main`; inspected HEAD `f9e35cf`
  (`fix(multiplayer): stabilize expo lobby presence and avatar synchronization`).
- B2 is committed at `babe2ca`. The frozen payment frontend and some venue/avatar
  source are still dirty/untracked. The working checkout builds, but **HEAD alone
  is not the release**: its Expo main imports the still-untracked `src/expo/tent.js`.
  `pay.html`, `src/btcinr/` and the Vite payment entry must also be committed together.
- The operator confirmed that only a local development setup is known. No Render
  service or production PostgreSQL database is confirmed. The blueprint now proposes
  exactly one new web service and one managed database; no public URL is assumed.
- Docker CLI is unavailable locally. The Node/Vite build passes, but the complete
  Alpine container image still needs a successful manual host/container build.
- Keep the existing **one-instance** architecture. World rooms, advertising fanout
  and B2 Socket.IO fanout are local; PostgreSQL does not make multiple gateways share
  room presence. The proposed attached disk also avoids overlapping instance swaps.

## Hosting configuration

Prepare a new Docker web service and managed PostgreSQL database using the existing
deployment architecture. Before creation, inspect the selected Render workspace for
matching resources. If either already exists, stop and reconcile it rather than
creating duplicates. Do not create a static-site-only deployment or split origins.

| Setting | Value |
| --- | --- |
| Repository branch / root | `main`; directory containing `Dockerfile` and `package.json` |
| Runtime | Docker; `Dockerfile`, context `.` |
| Process | `node server/main.js` (Docker CMD) |
| Instances | Exactly 1; do not enable autoscaling |
| Proposed web plan/disk | Starter and `omen-data`, 1 GiB mounted at `/data`; not yet created |
| Proposed database | `omen-db`, PostgreSQL 16, `0.1c-256mb` compute, 1 GiB storage; not yet created |
| Region | Singapore for both new resources |
| Database connection | `DATABASE_URL` references `omen-db.connectionString`; same-region private network |
| Database public ingress | Disabled by `ipAllowList: []` |
| Auto-deploy | Off; blueprint `autoDeployTrigger: "off"` |
| Pre-deploy command | `node server/manage.js migrate` |
| Health check | `/api/health` |
| Port / bind | `PORT=8787`, host `0.0.0.0`; Docker probe also honors a different assigned PORT |
| Public entry URLs | `/`, `/expo.html`, `/pay.html` on the same HTTPS origin |
| Socket.IO transport route | `/socket.io/`, Engine.IO v4, polling and WebSocket upgrade |
| Namespaces | `/world`, `/btcinr`, existing `/merchant` |

Render supports inbound WebSockets; public clients must use WSS. Relative Socket.IO
URLs automatically select WSS when the page is HTTPS. No extra proxy container or
separate WebSocket port is needed. See [Render WebSockets](https://render.com/docs/websocket)
and [port binding](https://render.com/docs/web-services#port-binding).

Editing these files does not create resources or change dashboard settings. Review
the proposed paid web/database/disk plans before approval. Blueprint creation/sync
can provision resources and start the first deployment, even with auto-deploy off.
Do not perform that action until the operator explicitly approves. Optional secret
prompts have been removed from the guest-demo template; integration support remains.

## Environment variables

Set secrets through the provider's environment/secret manager. Do not paste them
into chat, source, screenshots, shell history or VITE variables.

| Variable | Submission configuration |
| --- | --- |
| `DATABASE_URL` | **Required secret**, automatically referenced from the proposed managed database. The generated Render internal URL uses the private network; do not append `sslmode=verify-full` to an internal URL. For an external connection, require verified TLS with its full hostname and trusted CA. |
| `NODE_ENV` | `production`; enables Secure player/merchant/moderator cookies |
| `PORT` | `8787` in the blueprint; an assigned host PORT is also supported |
| `DATA_DIR` | `/data`; legacy import/checksum source, not the ledger store |
| `TRUST_PROXY` | `1` only behind the trusted Render proxy, which supplies forwarded client addresses |
| `ALLOWED_ORIGIN` | Empty for the recommended same-origin deployment. No wildcard CORS. |
| `BTCINR_DEMO_INR_PER_BTC` | `5734210.55` for a deterministic **configured-demo** reference rate. It is not represented as live pricing. Empty selects CoinGecko and makes quoting depend on provider availability. |
| `COINGECKO_API_KEY` | Optional server-only provider key when using CoinGecko |
| `NODE_EXTRA_CA_CERTS` | Optional provider CA file path when required; keep default certificate verification enabled |
| `WORLD_ID_ENVIRONMENT` | `production`; no effect on guest access |
| `WORLD_ID_CLIENT_ID`, `WORLD_ID_CLIENT_SECRET`, `WORLD_ID_REDIRECT_URI` | Optional real OIDC setup; leave all unset for guest-only submission. Redirect must be the registered exact `https://<origin>/api/auth/world/callback`. No fake verification. |
| `OMEN_ACCOUNT_USERNAME`, `OMEN_ACCOUNT_PASSWORD`, `OMEN_ACCOUNT_ROLE`, `OMEN_ACCOUNT_PLAYER_ID`, `OMEN_ACCOUNT_DISABLED` | Temporary **operator-only** moderator provisioning; remove from runtime environment after provisioning |
| `VITE_ARKIV_ACCESS_KEY` | Optional public, origin-restricted build argument; never a signing key |
| `CHECKOUT_ADDRESS`, `WHITECHAIN_RPC`, `MIN_CONFIRMATIONS`, `RELAYER_PRIVATE_KEY`, `RELAYER_MAX_PER_HOUR`, `RELAYER_MIN_WBT` | Existing optional Whitechain testnet integration. Leave checkout/relayer keys unset for a DEMO-only submission. No new chain deployment is needed. |
| `MERCHANT_KEYS`, `WEBHOOKS`, `WEBHOOK_SECRET`, `BILLBOARD_PAYOUT` | Existing optional legacy merchant/webhook/testnet advertising configuration; not required for B2 merchant sign-up or guest judging |
| `ZG_MODE`, `ZG_API_KEY`, `ZG_PRIVATE_KEY`, `ZG_BASE_URL`, `ZG_MODEL`, `ZG_PROVIDER`, `ANTHROPIC_API_KEY` | Optional existing inference. Use `ZG_MODE=off` and no paid inference keys for the no-spend demo profile. |
| `TEST_DATABASE_URL` | Local/CI only: disposable database for tests; never production |

`ARKIV_PRIVATE_KEY` and `DEPLOYER_KEY` are not runtime requirements. Never set
`VITE_RELAYER_PRIVATE_KEY`, `VITE_WORLD_ID_CLIENT_SECRET`, or other browser secrets.
Existing optional configured integrations were not removed or overwritten by this audit.

## PostgreSQL, migration and persistence

After approval, provision the blueprint's one managed PostgreSQL database in the
same workspace/region as the web service. The backend database role needs
ownership/DDL permission for its dedicated database/schema; no superuser is needed.
PostgreSQL persists balances, journals, receipts, outbox, identities, sessions, ads,
statistics and image bytes. The web disk is not a replacement for PostgreSQL backups.

The default proposal uses Render's internal connection URL with external ingress
disabled. This is private-network access, not a claim of certificate-verified database
TLS. Render's internal certificates are self-signed and do not support verify-full.
If verified database TLS is required, an operator can use the full external hostname
with `sslmode=verify-full` and allow only the web service's outbound IP ranges. Do not
add `rejectUnauthorized:false` or disable verification in application code. See
[Render database connection guidance](https://render.com/docs/postgresql-creating-connecting).

Before migration on a database with data, take a provider backup/snapshot and verify
that restoration is available. If using `pg_dump`, load `PGHOST`, `PGPORT`, `PGUSER`,
`PGPASSWORD`, `PGDATABASE` and `PGSSLMODE` securely, then run (backup outside the repo):

```powershell
pg_dump --format=custom --file="C:\private-backups\omen-predeploy.dump"
```

Migration files 001–003 are additive, advisory-locked and checksum-verified. The
Render pre-deploy command applies them before starting the new service. It does
not import legacy JSON. Pre-deploy processes cannot access `/data`; see
[Render deploy steps](https://render.com/docs/deploys) and
[disk limitations](https://render.com/docs/disks).

If an existing `/data` has legacy JSON/uploads, import an exact offline backup from
a machine that can read it and connect to the intended production database **before
starting the new gateway**. Stop old JSON writers first. Do not delete or rewrite
the originals, change their bytes after import, or copy test schemas into production.
For a fresh empty installation there is no legacy import to perform.

These are manual PowerShell commands; use the provider connection via a hidden
prompt or secret-manager-injected environment, not a URL embedded in command history:

```powershell
$dbSecret = Read-Host "Production PostgreSQL URL" -AsSecureString
$env:DATABASE_URL = [System.Net.NetworkCredential]::new('', $dbSecret).Password
Remove-Variable dbSecret
$env:NODE_ENV = 'production'
# Only if legacy data exists: point to its exact offline backup directory.
$env:DATA_DIR = 'C:\private-backups\omen-legacy'
node server/manage.js migrate
# Only if legacy data exists:
node server/manage.js import
node scripts/production-check.mjs
```

Set `DATA_DIR=/data` on Render regardless of the workstation backup path. If old
sources remain on the host disk, their bytes must match the imported checksums.
Startup fails closed on missing/modified migrations or unimported legacy records.
Do not use `npm test` with the production connection string.

To administer ads, provision an individual moderator before judging (guests do not
need this account). Set the temporary OMEN_ACCOUNT_* values in your private shell,
run `node server/manage.js account`, then remove the provisioning password from the
shell and host. The B1 README documents allowed roles and password requirements.

## Exact manual release commands

First inspect the intended Render workspace for duplicate resources. If an existing
OMEN service is discovered, turn **Auto-Deploy Off** before pushing and reconcile it
with this plan. No creation/deploy command should be run before operator approval.
If using an installed Render CLI, its read-only validation command is:

```powershell
render blueprints validate render.yaml
```

From the checkout (`C:\Users\HARDIK\Downloads\omen\omen`):

```powershell
git status --short
git diff --check
npm.cmd ci
npm.cmd ci --prefix server
npm.cmd run build
npm.cmd test
# Set TEST_DATABASE_URL to a disposable test database, not production, before:
npm.cmd --prefix server test
```

Review the pending Claude source as a unit. These explicit staging commands include
the required frozen frontend/venue files and deployment audit, excluding references,
screenshots, generated caches, database data and local TLS private keys:

```powershell
git add -- src/assets.js src/expo/layout.js src/expo/map.js src/expo/tent.js test/venue-layout.test.js vite.config.js pay.html src/btcinr test/btcinr-frontend.test.js e2e/btcinr-phones.mjs e2e/tent.mjs docs/contracts/btc-inr-frontend-requirements.md
# Preserve the pending avatar source/assets if they are part of the frozen release:
git add -- src/human.js public/models/human.glb tools/blender/humanoid.py tools/blender/humanoid_rig.py
git add -- .dockerignore .env.example Dockerfile README.md render.yaml server/README.md server/index.js scripts/production-check.mjs test/production-health.test.js docs/PRODUCTION-DEPLOYMENT.md
git diff --cached --stat
git diff --cached --check
# Operator executes only after reviewing the staged source:
git commit -m "chore(deploy): freeze submission and prepare production hosting"
git push origin main
$releaseCommit = git rev-parse HEAD
```

No `git add .`: it could expose local evidence, reference files or generated assets.
Do not remove pending Claude files to make the worktree appear clean.

After the operator approves resource creation and first deployment, use **one** of
these paths, not both:

1. **Blueprint (recommended):** Render → New → Blueprint → select `HNTRHACK/OMEN`,
   the reviewed branch/commit and `render.yaml`. Review exactly `omen` and `omen-db`,
   their Singapore region and paid plans. Apply once. Render supplies DATABASE_URL
   from the database reference, applies migrations and starts the web service.
2. **Manual dashboard:** create one PostgreSQL 16 database with the proposed region,
   compute/storage and external-ingress restriction. Create one Docker Web Service
   from the reviewed repository with the table's settings. Put the database's internal
   URL into DATABASE_URL privately. Do not then apply the new-resource blueprint as
   a second creation path. Record both actual resource IDs and the assigned HTTPS URL.

No existing legacy production disk/database is assumed. A new empty database needs
migrations 001–003, not a legacy import. Copying local development records is a
separate operator decision; do not automatically upload development sessions/data.
For later releases, choose Manual Deploy with the reviewed commit on the same service.

Equivalent command with an installed/authenticated official Render CLI (operator only):

```powershell
$env:RENDER_SERVICE_ID = 'srv-REPLACE_WITH_CONFIRMED_SERVICE_ID'
render deploys create $env:RENDER_SERVICE_ID --commit $releaseCommit --wait
```

The deploy command and `--commit`/`--wait` flags are documented in the
[official CLI reference](https://render.com/docs/cli-reference). Credentials remain in
the CLI login/secret manager; do not print a Render API key or use a deploy-hook URL
in source. Do not run the command until production database and legacy readiness pass.

If using Docker outside Render, build manually with `docker build -t omen:submission .`,
then run `node server/manage.js migrate` from that image with a securely supplied env
file before starting it. Attach the existing legacy directory read-only for an import.
The existing provider must supply HTTPS termination and WebSocket upgrades; this
audit does not introduce a second reverse proxy stack.

## Public acceptance after the operator deploys

Use the actual host URL; `omen.onrender.com` is not assumed to be your assigned URL.
These commands do not print secrets:

```powershell
$publicOrigin = 'https://REPLACE_WITH_ACTUAL_PUBLIC_HOST'
(Invoke-WebRequest "$publicOrigin/api/health" -UseBasicParsing).StatusCode
(Invoke-WebRequest "$publicOrigin/expo.html" -UseBasicParsing).StatusCode
(Invoke-WebRequest "$publicOrigin/pay.html" -UseBasicParsing).StatusCode
$rate = Invoke-RestMethod "$publicOrigin/api/btcinr/rate"
$rate | Select-Object settlement, source, stale
$transport = Invoke-WebRequest "$publicOrigin/socket.io/?EIO=4&transport=polling" -UseBasicParsing
if (-not $transport.Content.StartsWith('0{')) { throw 'Socket.IO transport failed' }
```

Then use two phones/independent sessions, ideally one on Wi-Fi and one on mobile data:

1. Open the exact same HTTPS `/expo.html` URL, enter different guest names without
   World ID, confirm online count two, visible peers and movement in both directions.
   Refresh/reconnect one; verify one avatar per ID. Confirm WSS upgrade 101 in browser
   network diagnostics; plain polling alone does not verify WSS.
2. On `/pay.html`, Phone B opens a new merchant with its own guest identity; Phone A
   creates a customer. Scan B's QR, quote, confirm once, compare the same persistent
   payment/order ID and exact debit/credit on both phones. Refresh both. All screens
   must say SIMULATED; there is no bank or Bitcoin settlement.
3. Advertiser submits an ad as a guest; the operator moderates with its private account.
   Both lobby clients must receive the change without refresh; verify takedown too.
4. Save only the public experience URL in the submission. Do not give judges operator,
   OIDC client or database credentials. Their guest identity is created in their browser.

Optional automated payment UI acceptance against the public service (creates DEMO
records, requires Chrome and ffmpeg): run `node e2e/btcinr-phones.mjs $publicOrigin`
with `CHROME_PATH` and an absolute `WORK` directory. Leave `E2E_SELF_SIGNED` unset:
public TLS must validate normally. The test camera displays the real merchant QR;
the API, balances, settlement and notifications remain real backend calls.

## Verified locally at the freeze

| Check | Actual result |
| --- | --- |
| Production Vite build | Passed, all five HTML entries including payment |
| Repository tests | 126 passed; no failures/skips |
| PostgreSQL integration suite | 54 passed; B1, World ID and B2; no failures/skips |
| Read-only production check | PostgreSQL reachable, migrations 001–003 verified, built entries/assets present |
| Production HTTPS/WSS proxy | Two independent guest Expo sessions, distinct IDs, real WSS frames |
| Advertising over WSS | Real submission → authenticated approval → both clients update; takedown updates both |
| Secure cookies / health | Secure HttpOnly moderator cookie over HTTPS; live database-aware health probe |
| Two-phone payment UI | All 8 cases passed with real PostgreSQL/backend, independent mobile browser sessions and secure merchant cookie |
| Payment amounts | ₹250 quote at configured-demo ₹5,734,210.55/BTC debited 4,360 satoshis once: 1,000,000 → 995,640; merchant 0 → 25,000 paise |
| Receipts and reconnect | Same payment/order IDs; ₹120 fixed request single-use; both histories/balances persist after refresh |
| Frozen frontend | No visual, avatar, Three.js, Blender or frontend application source was edited by this audit |

The TLS test terminates a **local self-signed certificate** at a reverse proxy and
uses browser ignoreHTTPSErrors only for that test. It exercises real production cookie,
origin and upgrade handling; it does not verify Render's certificate, domain, firewall,
public routing, container build, hosted DB availability, backups or two physical phones.
Those are explicit outstanding operator acceptance gates, not claimed successes.

Safe evidence: `artifacts/production-pay/https-wss-lobby.png`,
`phone-A4-receipt.png`, `phone-B4-live-notification.png`, `phone-B5-same-receipt.png`,
`https-smoke.json`. Do not publish the access-code screenshot or local TLS private key.

## Audit changes and rollback

Audit source changes: `.dockerignore`, `.env.example`, `Dockerfile`, `README.md`,
`render.yaml`, `server/README.md`, `server/index.js`, `scripts/production-check.mjs`,
`test/production-health.test.js`, `docs/PRODUCTION-DEPLOYMENT.md` and a test-only
`E2E_SELF_SIGNED` option in the pending `e2e/btcinr-phones.mjs`. No feature was added
to the frontend. Existing dirty/untracked frontend/asset files were preserved.

Health now checks PostgreSQL directly with a bounded query instead of taking the
economy snapshot/advisory lock. Failure returns 503 without database details. The
Docker probe honors PORT, the process binds explicitly to `0.0.0.0`, and startup
still verifies migrations/import before accepting traffic.

For a failed pre-deploy migration, inspect the error and repair inputs; transactional
migrations roll back pending DDL. Do not edit applied migration files. For a failed
application release, manually redeploy the previous compatible commit and preserve
PostgreSQL. Do not drop tables, restore stale JSON or automatically roll back the
ledger. A database restore requires stopped writers and a verified backup plan.

READY TO DEPLOY — stop for the operator's manual release and public acceptance.
