# Avatar face: what the frontend needs from the backend

**Status: PROPOSED v0.1, for Codex.** Frontend owner: Claude. Builds on `server/CONTRACT-WORLD-ID.md` (v1).

## What exists now (frontend, this milestone)

- **Avatar creator.** It can start from a selfie or photo, or manually. On-device MediaPipe landmarks map to a stylised face in `src/selfie.js` and `src/selfie-map.js`, which is rendered on the existing courier rig by `src/avatar-face.js`.
- **Face data.** A face is **13 small integers** defined in `shared/face.js` (`FACE_OPTIONS`, `cleanFace`), exactly like `shared/look.js`. It contains no photo, landmarks or measurements. The client keeps it at `look.face`.
- **World ID.** The client uses contract v1 as written:
  - `/api/auth/me`, `/api/auth/world/status`, `/api/auth/world/start`, `/api/auth/logout`, `GET` and `POST /api/avatar` (revision-checked), all with `credentials: "same-origin"`.
  - Badges come only from server fields. Sandbox sessions are labelled as test accounts, and a 401 `session_expired` is shown as expired, never as guest.
  - Nametags read `verifiedHuman` from peer objects, and the client handles `profile:update` and `identity:expired`.

## The gap

1. **Multiplayer.** `cleanLook()` in `shared/look.js` drops unknown keys, so `look.face` never reaches other players. They see the original courier face.
2. **Account persistence.** `POST /api/avatar` rejects any `look` key outside `LOOK_OPTIONS` (`400 bad_avatar`). So the frontend posts only the base look and keeps the face in `localStorage["omen.face.<avatarId>"]`. That copy is on one device only; a verified player on a new device gets their base look but not their face.

## Requested change (backward compatible)

Accept an optional nested `face` object, validated by the existing pure function in `shared/face.js`:

```js
import { cleanFace } from "./face.js";
export function cleanLook(raw) {
  const out = { /* existing loop over LOOK_KEYS, unchanged */ };
  const face = cleanFace(raw?.face); // null when absent; every key an in-range integer, nothing extra
  if (face) out.face = face;
  return out;
}
```

- **Realtime:** no other change. `join`, `look`, `players`, `joined` and `profile:update` already carry `look`.
- **`/api/avatar`:** allow `look.face` in the validation at `server/world-identity.js` (the `Object.entries(body.look)` check), stored inside `avatar_look` jsonb. When `face` is absent on save, it should be removed, matching "look replaces the entire look".
- **Size:** at most 13 integers below 7, about 200 bytes of JSON per player.
- **Old clients:** they never send `face`, so nothing changes for them.

Once this ships, the frontend needs no change: it already sends `look.face` and renders any `face` it receives. Then it stops using the device-local copy.

## Privacy expectations (please keep)

- Never accept or store images, landmarks, measurements or embeddings: only `cleanFace()` indices.
- `face` is appearance, not identity. Never use it for authentication, uniqueness or matching. World ID stays the only human check.

## Acceptance

`e2e/selfie.mjs` check 8 already compares a courier built from a look with and without `face`. After the change, a two-browser run against the real backend should show B rendering A's face (eye width, head scale, face parts). I'll add that run once the backend is reachable locally.
