// Signed payment webhooks for merchants' own backends.
//
//   WEBHOOKS="maya-chai=https://example.com/omen-hook"   (comma-separated, one per merchant)
//   WEBHOOK_SECRET=<random string shared with the merchant>
//
// Each POST carries   X-Omen-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
// Merchants verify with verifyWebhook() (also in the checkout SDK) and reject stale timestamps.
import { createHmac, timingSafeEqual } from "node:crypto";
import { merchantView } from "./realtime.js";

const EVENTS = { SUBMITTED: "payment.submitted", COMPLETED: "payment.completed", FAILED: "payment.failed" };

export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** Verify a webhook. Returns true only for a fresh, correctly signed body. */
export function verifyWebhook(secret, body, header, { toleranceSec = 300, now = Date.now() } = {}) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || ""));
  if (!m) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > toleranceSec) return false;
  const want = Buffer.from(sign(secret, body, Number(m[1])).split("v1=")[1], "hex");
  return timingSafeEqual(want, Buffer.from(m[2], "hex"));
}

export function parseHooks(env = process.env.WEBHOOKS || "") {
  const m = new Map();
  for (const pair of env.split(",")) {
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const url = pair.slice(i + 1).trim();
    if (/^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) m.set(pair.slice(0, i).trim(), url);
  }
  return m;
}

export function createWebhooks({ hooks = parseHooks(), secret = process.env.WEBHOOK_SECRET || "", fetchImpl = fetch, retryMs = [0, 2000, 8000] } = {}) {
  const sent = new Set(); // payment id + event: each event is delivered once per process
  const log = [];
  async function deliver(url, body) {
    for (const wait of retryMs) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 5000);
        const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-omen-signature": sign(secret, body) }, body, signal: c.signal }).finally(() => clearTimeout(t));
        if (res.ok) return { ok: true, status: res.status };
        if (res.status < 500 && res.status !== 429) return { ok: false, status: res.status }; // don't retry 4xx
      } catch {
        /* network error: retry */
      }
    }
    return { ok: false, status: 0 };
  }
  return {
    enabled: () => hooks.size > 0 && !!secret,
    log,
    /** Fire-and-forget; resolves when delivery finishes (tests await it). */
    notify(p) {
      const event = EVENTS[p.state];
      const url = p.merchant?.id && hooks.get(p.merchant.id);
      if (!event || !url || !secret) return Promise.resolve(null);
      const key = `${p.id}:${event}`;
      if (sent.has(key)) return Promise.resolve(null);
      sent.add(key);
      const body = JSON.stringify({ event, id: key, createdAt: Date.now(), data: merchantView(p) });
      return deliver(url, body).then((r) => {
        log.unshift({ at: Date.now(), event, payment: p.id, ...r });
        log.length = Math.min(log.length, 100);
        return r;
      });
    },
  };
}
