# World ID / avatar creator contract for Claude

Backend-owned contract, version 1. No frontend or 3D files are changed by this milestone.
World ID is implemented as **OIDC authorization code + S256 PKCE**, not the deprecated legacy
Sign In widget or a one-use IDKit action. No client-provided proof, nullifier, avatar ID, badge,
wallet address or verification flag grants authentication.

## Browser flow

1. `GET /api/auth/world/status` returns
   `{configured,environment,provider:"world-id",flow:"authorization-code-pkce",requiredCredential:"orb"}`.
   A configured flag only means settings are present; it is not evidence of a completed live login.
2. `POST /api/auth/world/start` with `{}` returns `{authorizationUrl,expiresIn:300}` and an HttpOnly
   browser-binding cookie. Navigate the **same browser** to the returned URL using a full-page redirect.
3. World ID redirects to `GET /api/auth/world/callback`. The backend validates state/browser binding,
   issuer, code, PKCE, token signature, nonce, audience, freshness, assurance and replay records.
   Success sets an HttpOnly OMEN session cookie and redirects to `/?world_id=success` (HTTP 303).
   Errors return the ordinary JSON envelope. The frontend must call `/api/auth/me` after returning;
   the query parameter alone never establishes verification.
4. Read `/api/avatar` and hydrate the avatar creator. Save changes through the owned API below.
5. Reconnect `/world` after signing in or out; cookies on the Socket.IO handshake select identity.

Use same-origin requests with `credentials:"same-origin"`. Do not put OMEN session tokens or World
ID credentials in localStorage. Guest clients keep their existing `x-omen-token` header and `join.token`.
Authenticated World ID cookies take priority over that guest token. Moderator and merchant sessions
remain separate credentials; they do not create player identity or verified badges.

## Current player

`GET /api/auth/me` returns `{player:null}` for anonymous visitors, or:

```json
{
  "player": {
    "accountId": "<persistent UUID>",
    "avatarId": "<persistent 24 lowercase hex characters>",
    "authType": "world-id",
    "verifiedHuman": true,
    "verificationEnvironment": "production",
    "sessionExpiresAt": 1794000000000
  }
}
```

Guests have `accountId:null`, their existing token-derived `avatarId`, `authType:"guest"`,
`verifiedHuman:false`, `verificationEnvironment:null` and `sessionExpiresAt:null`.
Sandbox World ID sessions have persistent accounts but **verifiedHuman:false** and
`verificationEnvironment:"sandbox"`. Show a test/sandbox label, never a production verified badge.
Invalid/revoked/expired player credentials return 401 `session_expired`; they never silently become
guest credentials. Logout clears an expired cookie so guest use can resume.

Guest economy records stay owned by the existing guest ID. They are not silently reassigned to a
verified account. World ID creates a separate persistent account; returning users always recover its
original avatar. Signing out restores the existing guest-token scope. Do not label that guest as verified.

## Owned avatar API

`GET /api/avatar` requires an active World ID OMEN session and returns:

```json
{
  "ownerAccountId": "<current account UUID>",
  "avatar": {
    "id": "<persistent avatar ID>",
    "displayName": "Courier",
    "look": { "skin": 0, "hair": 0, "hairStyle": 0, "hat": 0, "hatColor": 0, "jacket": 0, "pants": 0, "scarf": 0, "body": 0, "accessory": 0, "pet": 0 },
    "revision": 0,
    "updatedAt": 1794000000000,
    "verifiedHuman": true
  }
}
```

`POST /api/avatar` accepts `{revision,displayName?,look?}`. `revision` must match the last read value;
success increments it and returns the same envelope. Display names are moderated, 2–16 characters.
`look` uses the existing `shared/look.js` option indices. When provided, it replaces the entire look;
omitted option keys reset to defaults. Unknown keys, noninteger/out-of-range options, ownership fields
and verification flags are rejected. `409 avatar_conflict` means reload before saving again.
There is no arbitrary target-account parameter: callers can update only their authenticated avatar.
Guest avatar customization continues through the existing client/guest multiplayer path.

## Returning users and recovery

Regular sign-in returns the same account and avatar for the same validated application-sector
identity, including on a new device. Lost cookies or a cleared browser never require a second account.
For explicit recovery, `POST /api/auth/world/start` with `{recover:true}` runs the same real
authentication flow, requires an existing matching account, and revokes all its previous OMEN
sessions before issuing a replacement. It returns 404 `account_not_found` for a different/new identity.
Recover access to the World ID itself through World ID's own recovery process; OMEN never merges
different subjects based on name, email, guessed account IDs, wallet addresses or client assertions.

`POST /api/auth/logout` with `{}` revokes the current session and clears its cookie. `{all:true}`
requires an active player session and revokes all sessions of that account. Sessions last eight hours.
Signing out of OMEN does not sign out of World ID's upstream browser session, or vice versa.

## Multiplayer

The existing `/world` join payload stays `{room,name?,look?,outfit?,token?,resume?}`.
For authenticated accounts, server-persisted name/look replace client-supplied appearance on join.
The acknowledgement adds `avatarId`, `verifiedHuman` and `avatarRevision`; `id` equals `avatarId`.
Peer objects in `players`, `joined`, and the new `profile:update` event add the same fields.
Render badges only from these server-issued fields. Never infer verification from a name, query
parameter, localStorage, IDKit success callback, client payload or a merely well-formed token.

Saving `/api/avatar` broadcasts `profile:update` and the compatible `look` event. For verified
sessions, raw socket `look` messages do not persist or override the saved avatar; use the owned API.
Guest socket appearance remains compatible with the previous protocol.
Session revocation emits `identity:expired` with `{error:"session_expired"}` and disconnects the player;
peers see removal of the badge/profile. Expiry and disabled accounts are also enforced server-side.
Private World ID subjects, tokens and authentication methods never enter public multiplayer payloads.

All errors use `{error,message}`. Important codes include `world_id_not_configured` (503),
`world_id_unavailable` (503), `world_id_invalid` (401), `invalid_attempt` (401),
`attempt_used_or_expired` (409), `proof_replayed` (409), `session_expired` (401),
`account_disabled` (403), `account_not_found` (404), `bad_avatar` (400), and `avatar_conflict` (409).

## Handoff status

This is the shared backend contract for Claude to consume. Frontend implementation/acknowledgement
and an independently observed production World ID login remain separate acceptance steps.
See `WORLD-ID.md` for application registration, required environment variables, and live validation.
