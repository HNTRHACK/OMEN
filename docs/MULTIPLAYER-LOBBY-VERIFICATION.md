# COMMIT NOW — MULTIPLAYER LOBBY FIX

Verified locally on 2026-11-07. No commit, push or deployment was performed.
The two-phone payment frontend is preserved for its separate milestone.

## Actual cause

Two independent guest browser contexts entered the same production `/expo.html`
URL. Both joined `omen-expo`, had different player IDs, and received real state
packets. Each remote avatar was in the correct Three.js scene and marked visible.
However, both local avatars spawned at exactly `x=-3,z=13,y=0`, and the remote
decoded to approximately `x=-3.00027,z=13.00117,y=0`. They visually overlapped.

The entry button also called `begin()` on click and again on form submission,
opening then replacing a socket. The client treated a connected transport as a
successful room join and did not send an immediate snapshot after acknowledgement.
The online count included avatars retained for the reconnect grace period.

## Focused changes

- Each room member receives a stable, distinct arrival slot in its join response.
  Expo maps its slot to clear arrival floor, preserving the original first spawn.
  All sixteen positions are tested for separation and collision-free placement.
- The Expo entry form submits once. The multiplayer client waits for its room join
  before publishing movement and immediately sends the placed avatar snapshot.
- Join messages include a validated initial state so late peers can render promptly.
  Refresh restores a valid previous position, including the elevated stage. Invalid
  or other-world coordinates are rejected. Transport reconnects do not teleport
  a player who has already been placed on the current page.
- Server `presence` events report actual connected room members. NPCs never enter
  this count. Reconnect ghosts keep their avatar slot for the existing ten-second
  grace period, but are excluded from the online count immediately on disconnect.
- Existing join/leave activity notifications, interpolation, same-origin Socket.IO,
  guest token identity and World ID authority remain in place. There is no second
  multiplayer service, simulated remote avatar or polling replacement.

Join acknowledgement additions: `spawnSlot`, `resumed`, `state`, `online`.
New `/world` server event: `presence: {online}`. Existing fields/events are retained.
The default Expo room is still `omen-expo`; named Expo rooms retain their existing
`expo-` prefix. Blockhaven uses its existing rooms and spherical placement.

The active Expo and network renderer inspected for this fix instantiate the existing
`Character('kai')` model. The new `human.glb`, `human.js`, Blender files and skinned
asset cloning work were preserved rather than activated or replaced by this fix.
No compatibility with a future, unintegrated humanoid renderer is claimed.

## Browser verification

`e2e/expo-multiplayer.mjs` serves the production `dist/` through the actual gateway,
migrates a temporary PostgreSQL schema, and uses independent Chrome browser contexts
with distinct local storage/cookies. It records real same-origin WebSocket frames.
It closes the actual server-side WebSocket transport to test automatic reconnection.
All test resources and its own schema are cleaned up on completion.

Passed checks:

1. A joins `/expo.html` as a guest, without World ID; online count is one.
2. B joins the identical URL later, gets a distinct ID and a separate arrival spot.
3. A sees B and B sees A: actual scene objects, visible avatars, on-screen name tags,
   non-negative floor heights and matching remote IDs. Each entry sends one join.
4. Keyboard movement in both directions is delivered and interpolated on the other
   browser. Measured movement exceeds 0.8 m and settled position error is below 8 cm.
5. Refresh retains B's guest ID and previous position; no duplicate remote remains.
6. Closing B's real transport reduces the online count to one; reconnection returns
   it to two with the same player ID, a new socket, and working remote movement.
7. A third guest joins at a mobile-sized 390×844 viewport and uses drag-to-look to
   see both real peers, including their on-screen name tags.
8. Closing that guest immediately updates the online count and emits the existing
   leave notice after the grace period; no phantom remote remains.
9. No browser page errors; server and client counts agree on two remaining players.

Screenshots/results:

- `artifacts/expo-multiplayer/asha-sees-ravi.png`
- `artifacts/expo-multiplayer/ravi-sees-asha.png`
- `artifacts/expo-multiplayer/reconnected-lobby.png`
- `artifacts/expo-multiplayer/mobile-late-join.png`
- `artifacts/expo-multiplayer/results.json`

No physical phones or remotely hosted URL were available to this test. It verifies
loopback HTTP/WebSocket routing, not external HTTPS/WSS or LAN reachability. Production
still requires one gateway instance and a proxy forwarding Socket.IO upgrades on the
same origin. No deployment/routing configuration was changed or claimed verified.

## Reproduction and regression results

Build the current checkout, then set `TEST_DATABASE_URL` to a disposable PostgreSQL
database and run:

```text
npm run build
node e2e/expo-multiplayer.mjs
npm test
npm --prefix server test
```

Optional `CHROME_PATH` selects Chrome/Chromium; `SHOTS` selects the artifact directory.
On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

| Check | Result |
| --- | --- |
| Production Vite build | Passed, including the preserved current payment entry |
| Real Expo browser acceptance above | All passed |
| Repository regression suite | 125 passed; 0 failed/skipped |
| PostgreSQL backend suite | 54 passed; 0 failed/skipped (B1, World ID and B2) |
| Syntax checks on changed JavaScript and scoped whitespace check | Passed |

The existing payment, advertising, World ID, commerce and mocked chain/Arkiv tests
remain passing. This checkpoint does not claim the separate payment UI acceptance.

## Exact source files changed by the lobby fix

Modified:

- `server/realtime.js`
- `src/net.js`
- `src/expo/main.js` (preserves its earlier venue/tent edits)

New:

- `src/expo/presence.js`
- `test/expo-presence.test.js`
- `test/expo-realtime.test.js`
- `e2e/expo-multiplayer.mjs`
- `docs/MULTIPLAYER-LOBBY-VERIFICATION.md`

The five final evidence files listed above are optional review artifacts. Other
dirty/untracked venue, payment, avatar and Blender work was not reverted or staged.
Review individual hunks in the already-dirty Expo main file when committing.

Suggested commit message:

```text
fix(multiplayer): make Expo lobby avatars visible across sessions
```

COMMIT NOW — MULTIPLAYER LOBBY FIX. Stop here for the manual commit before the next milestone.
