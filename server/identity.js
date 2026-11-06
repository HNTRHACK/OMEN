// Guest identity without sign-up. Each browser keeps a random 256-bit secret ("token"); the public
// player id is derived from it. The server stores no passwords and nothing that could be used to
// impersonate anyone: knowing an id doesn't give you its token.
import { createHash } from "node:crypto";

export const TOKEN_RE = /^[a-f0-9]{64}$/;
export const ID_RE = /^[a-f0-9]{24}$/;

export const playerIdOf = (token) => createHash("sha256").update(`omen-player:${token}`).digest("hex").slice(0, 24);

/** The caller's player id from the x-omen-token header, or null. */
export function playerFromRequest(req) {
  const t = String(req.headers["x-omen-token"] || "");
  return TOKEN_RE.test(t) ? playerIdOf(t) : null;
}
