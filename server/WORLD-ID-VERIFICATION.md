# COMMIT NOW — WORLD ID BACKEND

Backend milestone verified locally on 2026-11-06 with Node 24.13.1 and PostgreSQL 16.13.
Starting B1 baseline: `e3690ad` (which completes `1a0156a`).

## Implemented

- Official World IdP OIDC authorization-code/PKCE flow with server-side RS256/JWKS verification,
  nonce/state/browser binding, issuer/audience/time/Orb assurance checks and bounded dependency calls.
- One PostgreSQL account and immutable avatar ID per validated `(issuer,subject)`, enforced by unique
  constraints; saved name/look with optimistic revision checks and authenticated ownership.
- Durable one-use authentication attempts, authorization-code hashes and token-JTI replay records.
- Hashed, expiring, revocable OMEN player sessions; returning-device login, session rotation,
  explicit same-identity recovery that retains the avatar and revokes earlier sessions.
- Explicitly unverified guests and sandbox identities; no automatic guest-record/account merges.
- Server-authoritative multiplayer profile/badge/appearance fields, reserved avatar protection,
  revocation/expiry handling and persistent avatar update synchronization.
- Compatibility with the existing advertising/marketplace player-ID paths and separate moderator/
  merchant credentials. No Whitechain or Arkiv implementation changes.

## Verification

| Check | Result |
| --- | --- |
| `npm --prefix server test` with disposable local `TEST_DATABASE_URL` | 32 passed: 16 B1 + 16 World ID; 0 failed/skipped |
| `npm test` | 112 passed; 0 failed/skipped |
| `npm audit --prefix server --omit=dev --audit-level=high` | 0 vulnerabilities |
| `node --check` for every top-level server JavaScript module | Passed |
| Backend `git diff --check` | Passed |
| Temporary B1/World ID PostgreSQL schemas after tests | 0 remaining |

World ID tests substitute only HTTP responses, generating local RSA-signed tokens and exercising the
production OIDC implementation, signature/claim checks, PKCE and database/session logic. Coverage
includes forged/unsigned/wrong-algorithm tokens; invalid audience, issuer, nonce, timing and assurance;
valid passkey/Face Auth profiles; login CSRF; replay and concurrent registration; recovery; session
rotation/revocation/expiry/disablement; production cookie properties; avatar ownership/revision races;
guest/sandbox separation; account persistence through database reconnect; and actual Socket.IO peers.

Existing advertising, commerce, Arkiv and mocked Whitechain tests passed. No blockchain transaction
was signed or submitted, and no live deployment was performed.

## Live acceptance is outstanding

**World ID is not claimed to be live.** No actual World IdP client credentials were available in the
environment, and no independent production login was performed. Real login requires an actual
registered OIDC client, exact HTTPS callback and valid World ID authentication. There is no runtime
fake verification mode. Configuration and the independent acceptance checklist are in `WORLD-ID.md`.

Claude's integration contract is `CONTRACT-WORLD-ID.md`. It defines login, current-player identity,
owned avatar read/update, recovery/logout and multiplayer events. The document is the backend handoff;
frontend implementation/acknowledgement remains Claude's responsibility.

## Exact backend file manifest

New files:

- `server/CONTRACT-WORLD-ID.md`
- `server/WORLD-ID.md`
- `server/WORLD-ID-VERIFICATION.md`
- `server/migrations/002_world_identity.sql`
- `server/test/world-id.test.js`
- `server/world-identity.js`
- `server/world-oidc.js`

Modified files:

- `.env.example`
- `render.yaml`
- `server/README.md`
- `server/config.js`
- `server/identity.js`
- `server/index.js`
- `server/package-lock.json`
- `server/package.json`
- `server/realtime.js`
- `server/test/b1.test.js`

The package manifests include the World ID dependency installed before the earlier pause; those
changes belong to this milestone. No frontend, 3D, shared appearance, root package manifest or
Blender files were edited by this backend work. Other actors changed/staged frontend files during
implementation; inspect the index and use this explicit manifest for the manual backend commit.
No staging, commit, push or history rewrite was performed by this backend agent.

Suggested commit message:

```text
feat(identity): add World ID authentication and persistent avatar ownership
```

Before running the new backend, set the World ID variables described in `WORLD-ID.md` and run
`node server/manage.js migrate` for migration 002. Preserve the existing single-instance deployment
rule. No BTC→INR payment backend work was started. This milestone stops for a manual commit.
