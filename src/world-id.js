// World ID, from the browser's side, through the backend's contract (server/CONTRACT-WORLD-ID.md):
//   GET  /api/auth/world/status  → { configured, environment }
//   POST /api/auth/world/start   → { authorizationUrl }   (then the browser goes to World ID)
//   GET  /api/auth/me            → { player: { authType: "guest" | "world-id", verifiedHuman, avatarId, … } }
//   GET  /api/avatar             → { avatar: { id, displayName, look, revision, verifiedHuman } }
//   POST /api/avatar             → { displayName?, look?, revision }  (409 avatar_conflict if stale)
// The "verified human" badge is shown ONLY when /api/auth/me says so. This file never decides it.
import { guestToken } from "./identity.js";

const call = async (path, { method = "GET", body } = {}) => {
  const r = await fetch(path, {
    method,
    credentials: "same-origin", // the World ID session is an httpOnly cookie set by the backend
    headers: { "x-omen-token": guestToken(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null); // a non-JSON reply means this server has no such API
  if (!r.ok || !j || typeof j !== "object") throw Object.assign(new Error(j?.message || `HTTP ${r.status}`), { status: r.status, code: j?.error });
  return j;
};

/**
 * Who this browser is, as the server sees it:
 *   { state: "verified" | "world-unverified" | "guest" | "unavailable", configured, environment, avatarId }
 */
export async function identity() {
  let me;
  try {
    const r = await call("/api/auth/me");
    if (!("player" in r)) return { state: "unavailable", configured: false };
    me = r.player; // null for an anonymous visitor
  } catch (e) {
    // an expired session must never silently turn into a guest (contract): say so
    if (e.status === 401) return { state: "expired", configured: true };
    return { state: "unavailable", configured: false };
  }
  let status = { configured: false };
  try {
    status = await call("/api/auth/world/status");
  } catch {
    /* sign-in unavailable; guest play is unaffected */
  }
  const base = { configured: !!status.configured, environment: status.environment || null, avatarId: me?.avatarId || null };
  if (me?.authType === "world-id") return { ...base, state: me.verifiedHuman === true ? "verified" : "world-unverified", environment: me.verificationEnvironment || null };
  return { ...base, state: "guest" };
}

/** Start World ID sign-in. Only ever navigates to an https World ID authorisation page. */
export async function signIn() {
  const { authorizationUrl } = await call("/api/auth/world/start", { method: "POST", body: {} });
  const u = new URL(authorizationUrl);
  if (u.protocol !== "https:" || !/(^|\.)world\.org$/.test(u.hostname)) throw new Error("Unexpected sign-in address; not following it.");
  location.assign(u.href);
}

/** Sign out of OMEN (also clears an expired session cookie so guest play resumes). */
export const signOut = () => call("/api/auth/logout", { method: "POST", body: {} });

export const loadAvatar = () => call("/api/avatar").then((r) => r.avatar);
/** Save name + base look (the backend accepts only shared/look.js keys today, so no face). */
export const saveAvatar = (displayName, look, revision) => call("/api/avatar", { method: "POST", body: { displayName, look, revision } }).then((r) => r.avatar);

/** The badge markup for a state. Never claims verification the server didn't confirm. */
export function badge(id) {
  switch (id.state) {
    case "verified":
      return `<span class="id-badge verified" title="World ID confirmed this account belongs to a unique human">✓ Verified human · World ID</span>`;
    case "world-unverified":
      return id.environment === "sandbox"
        ? `<span class="id-badge world" title="A World ID sandbox (test) sign-in: not a verified human">World ID sandbox · test account, not verified</span>`
        : `<span class="id-badge world" title="Signed in with World ID, but the server hasn't confirmed verified-human status">World ID · not a verified-human badge</span>`;
    case "expired":
      return `<span class="id-badge expired">World ID session expired · sign in again</span>`;
    case "guest":
      return `<span class="id-badge guest">Guest courier</span>`;
    default:
      return `<span class="id-badge guest" title="This server doesn't offer World ID sign-in">Guest courier · World ID unavailable</span>`;
  }
}
