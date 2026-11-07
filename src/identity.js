// This browser's guest identity: a random 256-bit secret kept in localStorage. It is sent to OMEN's
// own server only (socket join + x-omen-token header) and never shown or logged.
let memo = null;
export function guestToken() {
  if (memo) return memo;
  try {
    memo = localStorage.getItem("omen.identity");
  } catch {
    /* storage blocked: a per-page identity still works */
  }
  if (!/^[a-f0-9]{64}$/.test(memo || "")) {
    memo = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    try {
      localStorage.setItem("omen.identity", memo);
    } catch {
      /* ignore */
    }
  }
  return memo;
}

/** fetch() to OMEN's API as this guest. */
export function authed(path, { method = "GET", body } = {}) {
  return fetch(path, {
    method,
    headers: { "x-omen-token": guestToken(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
