# World ID backend

Implementation status: **automated verification only; production World ID sign-in has not been
independently verified**. No live World ID credentials are present in the implementation environment.
There is no demo/fake verification mode in the running backend. Missing credentials leave World ID
login unavailable and guest play available. Test HTTP doubles and signing keys exist only in tests.

The frontend/creator integration is specified in [CONTRACT-WORLD-ID.md](CONTRACT-WORLD-ID.md).
The milestone adds migration `002_world_identity.sql`; do not edit migration 001 or reimport JSON.

## Official authentication flow

The backend follows World IdP's current OIDC authorization-code flow for new sign-in integrations.
It discovers the official issuer's endpoints, requests `openid`, uses a confidential client with
`client_secret_basic`, and binds each attempt to a browser cookie, random state, random nonce,
and private S256 PKCE verifier. The callback must contain the expected issuer. A five-minute attempt
is consumed in PostgreSQL before a code is exchanged; a failed or uncertain callback cannot replay.

`openid-client` validates RS256 signatures using the issuer's JWKS, including explicit
`enableNonRepudiationChecks`, and checks issuer, audience, expiry, issued-at time, requested nonce
and maximum authentication age. OMEN separately checks subject/JTI presence, authentication context,
auth-time bounds and Orb assurance. Endpoints must stay on the selected official HTTPS origin;
redirects are not followed. Dependency calls have eight-second timeouts and bounded library JWKS
caching. Provider errors never count as identity approval and raw upstream errors/tokens are not
included in API responses.

OMEN requests the essential classes `https://world.org/oidc/acr/orb` and
`https://world.org/oidc/acr/orb-face`, with `max_age=300`. Orb-verified accounts may authenticate with
a World ID proof or an enrolled passkey. The badge means an authenticated account carrying Orb
assurance; it does not mean that a new iris/face scan occurred during every login. Selfie-only and
unverified classes are rejected. An upstream authentication up to five minutes old may be reused.

This is **not** an IDKit one-use action integration. IDKit applications, RP signing keys and
nullifiers are not interchangeable with OIDC client registrations and stable sector subjects.
No raw ID token or frontend proof-submission endpoint is accepted from the browser.

## Persistent identity and ownership

`player_accounts` has a unique constraint on exact, case-sensitive `(world_issuer,world_subject)`.
The validated subject is scoped to the application's registered World ID sector. Each account also
has one unique, random 24-hex avatar ID and a persistent display name, look and revision. Concurrent
first-time logins resolve to the same account/avatar; the database constraint is the final guard.
Subjects and tokens are not exposed in the current-player, avatar or multiplayer API.

Returning users authenticate again on any browser/device and receive a session for the same mapping.
Explicit recovery (`{recover:true}` on login start) requires that same validated identity to exist
already, retains its avatar/appearance, and revokes all prior OMEN sessions. There is no recovery by
email, display name, wallet address, public avatar ID or an administrator-set verified flag.
Recovering access to the underlying World ID is handled by World ID. If the issuer returns a new
subject after an identity/sector change, OMEN does not infer continuity or merge accounts.

Guest identity keeps the existing random browser token and is always unverified. Guest-owned ads,
shops and records are preserved under their original guest ID. They are not automatically migrated
to a verified account, because possession of a guest token must not become permanent authentication
for a verified identity. With a valid player cookie, existing economy routes use the verified
avatar ID; after logout they use the existing guest token again. Moderator and merchant credentials
remain separate, and no World ID login grants moderation or merchant permissions.

## Sessions, replay and multiplayer

Player sessions use random 256-bit credentials; only SHA-256 hashes persist. Production cookies use
`__Host-omen_player`, Secure, HttpOnly, SameSite=Lax and Path=/ with no Domain. The callback binding
cookie is Secure/HttpOnly/SameSite=Lax and scoped to `/api/auth/world/callback`. Local nonproduction
tests use `omen_player`/`omen_world_flow` without Secure. Sessions expire after eight hours. New
login rotates the initiating browser's prior session; ordinary login on a different device does not
revoke the other device. Logout revokes the current session; all-session logout and recovery revoke
the account's previous sessions. Disabled accounts cannot authenticate or reuse old sessions.

Attempts have unique state hashes/nonces and atomically consumed code hashes. `world_token_uses`
uniquely records each validated `(issuer,jti)` until the ID token expires, preventing reuse across
different attempts. Authentication state and account/session creation are separate transactions:
verification failure cannot roll back attempt consumption. Neither browser-provided success flags
nor merely knowing an application-scoped subject can mint a session.

Multiplayer resolves the same database-backed player session during join. Verified names and
appearance come from the owned persistent avatar, not the join payload. Public profiles contain
only server-issued avatar ID, name/look, revision and verified status. The `profile:update` event
and compatible `look` event synchronize saved changes. Revocation through logout/recovery immediately
disconnects affected local sockets and removes their profiles/badges. Session expiry has a server
timer; packets also check active sessions. A ten-second sweep detects out-of-process database
revocation/disablement for idle connected players. Database errors fail closed for authenticated
socket activity. Keep the existing single-instance deployment rule until cross-instance event
fanout is implemented.

Sandbox and production use different issuers and identity namespaces. Sandbox sessions can save
avatars, but their API and multiplayer `verifiedHuman` value is always false. They must be presented
as sandbox/test identities rather than real verified humans.

## Application registration and configuration

1. Register an OIDC client for OMEN in the World IdP developer portal linked from the official client
   setup guide. Use the portal matching production or sandbox. This is not an IDKit `app_id`/action.
2. Keep the application in its own managed identity sector. Sharing a sector deliberately shares
   subjects between applications; choose this before collecting account mappings.
3. Register the exact HTTPS callback, e.g. `https://omen.example/api/auth/world/callback`. Wildcards,
   changing ports, query strings and fragments are not accepted by this backend.
4. Select `client_secret_basic`, which this implementation supports. Set default accepted accounts
   to Orb; OMEN additionally requires Orb classes in every request and checks the returned assurance.
5. Put the client ID and secret in server/hosting secrets. Never put secrets in `VITE_*` or chat,
   frontend bundles, repositories or request logs. Disable callback query-string logging at proxies.
6. Run `node server/manage.js migrate` against the configured PostgreSQL database before starting.
   Existing B1 records are untouched by the additive migration.

| Environment variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection, as in B1. |
| `WORLD_ID_ENVIRONMENT` | `production` (default) or `sandbox`; selects the fixed official issuer. |
| `WORLD_ID_CLIENT_ID` | OIDC client ID from the matching World IdP registration. |
| `WORLD_ID_CLIENT_SECRET` | Server-only OIDC secret for `client_secret_basic`. |
| `WORLD_ID_REDIRECT_URI` | Exact registered HTTPS `/api/auth/world/callback` URL. |
| `NODE_ENV` | Use `production` behind HTTPS to enforce Secure cookies and production cookie names. |
| `ALLOWED_ORIGIN` | Existing B1 setting. Same-origin frontend/API hosting is required for this browser-cookie login flow. |
| `TRUST_PROXY` | Existing B1 setting; enable only behind a trusted proxy that overwrites forwarded headers. |
| `TEST_DATABASE_URL` | Disposable test database; never point tests at production. |

All three OIDC credential/callback fields must be present together. If all are empty, guests still
work and `/api/auth/world/start` returns 503 `world_id_not_configured`. An invalid partial configuration
fails startup. The backend does not support arbitrary issuer URLs or development verification toggles.
Native/server API clients may send an existing OMEN session as `x-omen-session`; no endpoint exposes
the cookie to browser JavaScript. Do not confuse it with the guest `x-omen-token` header.

Keep the same sector/issuer to preserve account mappings when rotating client secrets or replacing
clients. Changing the issuer or sector changes the identity namespace. Retain backups of PostgreSQL;
avatar ownership and session revocations are in the database, not local JSON files. Existing Whitechain
and Arkiv configuration and wallet authorization flows remain unchanged.

## Verification and remaining live acceptance

Run `npm --prefix server test` with `TEST_DATABASE_URL`, then `npm test`. Automated World ID tests
exercise real RSA verification through the production OIDC implementation while substituting only
the provider's HTTP responses. They cover forged signatures/claims, login CSRF, nonce/state/PKCE,
proof/code replay, expiry/outages, concurrent registrations, uniqueness constraints, returning users,
recovery, session rotation/revocation, avatar ownership/revision conflicts, sandbox badge separation,
and actual multiplayer profiles. Existing B1, advertising, marketplace, Whitechain-mock and Arkiv
tests run alongside these. No test sends a blockchain transaction.

Before claiming World ID is live, a human operator must independently:

1. Configure an actual registered production client and complete a production World ID login.
2. Confirm `/api/auth/me` and `/api/avatar` return the expected account, avatar and verified status.
3. Repeat on a second browser/device and confirm the same account/avatar rather than a new registration.
4. Confirm a peer receives the server-authoritative badge and saved appearance.
5. Complete recovery/logout and confirm old sessions and connected peers lose access.
6. Confirm a guest and sandbox identity never receive a production verified badge.

Credential configuration alone, signed local fixtures and a sandbox login do not satisfy this check.
No deployment, commit or upstream application registration is performed automatically.

Official references checked for this milestone:

- [World ID authentication / code flow](https://auth.world.org/docs/guides/oidc)
- [Token claims and scoped identities](https://auth.world.org/docs/guides/id-token)
- [Application registration and sector continuity](https://auth.world.org/docs/guides/app-registration)
- [Sandbox and independent testing](https://auth.world.org/docs/guides/testing)
- [OIDC signature verification](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md)
