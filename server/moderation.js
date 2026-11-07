// Shared moderation for the forum, local chat and billboard ads.
// Deliberately simple and conservative: it refuses the scams that rob people in crypto spaces,
// masks common profanity, limits links, and leaves judgement calls to human moderators (reports
// hide content after REPORT_HIDE distinct reporters until a moderator reviews it).
import { clean } from "./commerce.js";

export const REPORT_HIDE = 3;

const SCAMS = [
  /seed\s*phrase/i,
  /secret\s*(recovery\s*)?phrase/i,
  /private\s*key/i,
  /\bmnemonic\b/i,
  /double\s+your\s+(crypto|money|eth|btc|usdt)/i,
  /\b(free|claim)\s+(airdrop|crypto|usdt|eth|btc)\b/i,
  /send\s+(me\s+)?\d*\s*(eth|btc|usdt|wbt|crypto)\b.*\b(back|return|double)/i,
  /\b(dm|whatsapp|telegram)\s+me\b.*\b(support|refund|recover|wallet)/i,
  /wallet\s*(validation|sync|recovery)\s*(site|link|tool)/i,
];
const PROFANITY = /\b(fuck\w*|shit\w*|bitch\w*|bastard\w*|cunt\w*|asshole\w*|dickhead\w*|motherfuck\w*|chutiya\w*|madarchod\w*|bhenchod\w*|behenchod\w*)\b/gi;
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Check user text. Returns { ok, text, reason }. Scams are refused; profanity is masked; links
 * are refused unless `links` allows that many.
 */
export function moderateText(raw, { max = 500, min = 1, links = 0 } = {}) {
  const text = clean(raw, max).replace(/\s{3,}/g, "  ");
  if (text.length < min) return { ok: false, reason: min > 1 ? `Write at least ${min} characters.` : "Write something first." };
  if (SCAMS.some((re) => re.test(text))) return { ok: false, reason: "That looks like a crypto scam pattern (seed phrases, private keys, 'double your crypto', airdrops). It wasn't posted." };
  const found = text.match(LINK) || [];
  if (found.length > links) return { ok: false, reason: links ? `At most ${links} link${links > 1 ? "s" : ""} here.` : "Links aren't allowed here." };
  for (const l of found) if (!safeUrl(l.startsWith("www.") ? "https://" + l : l)) return { ok: false, reason: "Only plain https links are allowed." };
  return { ok: true, text: text.replace(PROFANITY, (w) => w[0] + "•".repeat(Math.max(2, w.length - 1))) };
}

/** An external link we're willing to show: https, a real hostname, no credentials, short. */
export function safeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.href.length > 200) return null;
  const h = u.hostname;
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes("[") || /(^|\.)(localhost|local|internal)$/i.test(h)) return null;
  return u.href;
}

/** Per-player token buckets: allow(playerId) → true/false. */
export function rateLimiter(perMin, burst = perMin) {
  const b = new Map();
  return (id, now = Date.now()) => {
    let s = b.get(id);
    if (!s) b.set(id, (s = { t: burst, at: now }));
    s.t = Math.min(burst, s.t + ((now - s.at) / 60_000) * perMin);
    s.at = now;
    if (b.size > 20_000) b.clear(); // bounded memory
    if (s.t < 1) return false;
    s.t -= 1;
    return true;
  };
}
