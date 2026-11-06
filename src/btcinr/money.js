// Exact money display for the BTC→INR demo. Paise are integers, satoshis are decimal strings
// (as the backend sends them); nothing here uses floating-point arithmetic on money.

/** Indian digit grouping for a non-negative integer string: 1234567 → "12,34,567". */
function groupIN(int) {
  const s = String(int);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/** 25000 → "₹250.00" (integer paise, any size). */
export function formatPaise(paise) {
  const p = BigInt(paise);
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? "−" : ""}₹${groupIN(a / 100n)}.${String(a % 100n).padStart(2, "0")}`;
}

/** "4360" → "0.00004360" BTC (8 decimals, exact). */
export function formatSats(sats) {
  const s = BigInt(sats);
  const neg = s < 0n;
  const a = neg ? -s : s;
  return `${neg ? "−" : ""}${a / 100_000_000n}.${String(a % 100_000_000n).padStart(8, "0")}`;
}

/** "5734210.55" (INR per BTC) → "₹57,34,210.55". */
export function formatRate(rate) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(rate));
  if (!m) return String(rate);
  return `₹${groupIN(m[1])}.${(m[2] || "").padEnd(2, "0")}`;
}

/**
 * Parse what someone typed as rupees into integer paise, exactly. Accepts "250", "250.5",
 * "1,250.50". Returns null for anything else (more than two decimals, signs, letters, zero).
 */
export function parseInr(text) {
  const t = String(text ?? "").trim().replace(/[,\s₹]/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return paise > 0 && Number.isSafeInteger(paise) ? paise : null;
}

/** Seconds/minutes ago, for "rate updated 8 s ago". */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** Payment request code from a scanned QR: only this site's pay link or the omenpay: scheme. */
export function codeFromQr(text, origin) {
  const t = String(text ?? "").trim();
  const RE = /^[A-Za-z0-9_-]{6,64}$/;
  let m = /^omenpay:r\/(.+)$/.exec(t);
  if (m) return RE.test(m[1]) ? m[1] : null;
  try {
    const u = new URL(t);
    if (u.origin !== origin) return null; // someone else's site: never trust it
    m = /^#\/r\/(.+)$/.exec(u.hash);
    return m && /\/pay\.html$/.test(u.pathname) && RE.test(m[1]) ? m[1] : null;
  } catch {
    return RE.test(t) ? t : null; // a typed code
  }
}
