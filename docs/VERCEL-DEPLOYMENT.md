# OMEN on Vercel

Release source is `HNTRHACK/OMEN`, branch `final-block`. The Vercel project is `omen`
in the existing `hntrhacks-projects` team. Do not deploy `master` or `main`.

`vercel.json` builds all six existing pages and routes API, uploads, `/socket.io/`
and `/royale-io/` to the same exported Node HTTP server. Production clients use
`VITE_SOCKET_PATH=/api/runtime` with no trailing slash and share one Engine.IO
server across all namespaces, so upgrades address the actual Function route. Fluid compute must remain
enabled. Socket.IO clients use WebSocket transport directly; connections reconnect
when a Function reaches its 300-second duration. Native Vercel WebSocket support
is documented at https://vercel.com/docs/functions/websockets.

Neon `DATABASE_URL` is used for transactions. `DATABASE_URL_UNPOOLED` must be a
direct connection: PostgreSQL LISTEN/NOTIFY and session-level coordination cannot
use a transaction pooler. TLS certificates are verified. The official Socket.IO
Postgres adapter coordinates broadcasts and instance discovery; the existing
world's profiles and movement are replicated between active instances.

`scripts/vercel-build.mjs` refuses a different branch, requires production World
ID configuration with guest bypass off, and applies the existing checksum-verified,
advisory-locked additive migrations. Migration 006 adds shared Final Block
sessions/avatars and the adapter's temporary attachment table. It does not reset
or replace existing application tables. No workstation JSON is imported into Neon.

Required World variables are `VITE_WORLD_APP_ID`, `WORLD_RP_ID`,
`WORLD_RP_SIGNING_KEY`, and `WORLD_ENVIRONMENT=production`. The signing key must be
a server-side secret. The main onboarding uses the IDKit signed-request/proof flow;
it has no OIDC callback. The separate optional OIDC flow uses
`WORLD_ID_CLIENT_ID`, `WORLD_ID_CLIENT_SECRET`, and the exact HTTPS
`WORLD_ID_REDIRECT_URI=/api/auth/world/callback`; do not partially configure it.
Register the production origin with the matching World application in its portal.

Bounty Royale grants only free, non-transferable, non-redeemable points after real
World verification. No payment/contract owner key is provisioned by this release.
Moderators use the existing authenticated dashboard at `/royale-admin.html`.
An operator must provision a moderator with `server/manage.js account` using
private temporary `OMEN_ACCOUNT_*` values; the deployment creates no public admin
password. Official project entries are imported through that dashboard. Optional
`ROYALE_DEMO_TEAMS=1` uses the existing conspicuously labelled sample teams, never
claims those teams are official entrants, and never publishes fabricated results.

After deployment:

```text
node scripts/check-live.mjs https://omen-mauve.vercel.app <full-deployed-sha>
```

This checks public assets, API health, release identity, request signing, rejected
unauthorized writes, and two independent WebSocket clients. It does not substitute
for browser rendering or two real World ID users logging in and staking points.
Those final browser/phone checks must be reported separately.
