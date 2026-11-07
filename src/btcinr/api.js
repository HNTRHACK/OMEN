// The browser side of Codex's BTC→INR API (server/CONTRACT-BTCINR.md). Every path, header and
// error code the two-phone demo uses is here.
//   Customer: the device's guest identity (x-omen-token) or a World ID session cookie.
//   Merchant: the HttpOnly merchant session cookie set by sign-up / sign-in (never stored by us).
import { io } from "socket.io-client";
import { guestToken } from "../identity.js";

export const LABEL = "SIMULATED BTC → INR SETTLEMENT";
const BASE = "/api/btcinr";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function call(path, { method = "GET", body, headers = {}, timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      credentials: "same-origin",
      headers: { "x-omen-token": guestToken(), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    throw new ApiError(0, "network", e.name === "AbortError" ? "The server didn't answer in time." : "No connection to the OMEN server.");
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 204) return {};
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new ApiError(r.status, j?.error || (r.status >= 500 ? "internal" : "bad_response"), j?.message);
  return j;
}

export const api = {
  rate: () => call("/rate"),
  customer: () => call("/customer").then((r) => r.customer),
  joinCustomer: (displayName) => call("/customer", { method: "POST", body: { displayName } }).then((r) => r.customer),
  merchant: () => call("/merchant").then((r) => r.merchant),
  signUpMerchant: (businessName, displayName) => call("/merchants", { method: "POST", body: { businessName, displayName } }),
  signInMerchant: (merchantId, accessCode) => call("/merchant/session", { method: "POST", body: { merchantId, accessCode } }),
  signOutMerchant: () => call("/merchant/session", { method: "DELETE" }),
  recoverMerchant: () => call("/merchant/recover", { method: "POST", body: {} }),
  fixedRequest: (inrPaise, reference) => call("/merchant/requests", { method: "POST", body: { inrPaise, ...(reference ? { reference } : {}) } }).then((r) => r.request),
  request: (code) => call(`/requests/${encodeURIComponent(code)}`).then((r) => r.request),
  quote: (requestCode, inrPaise) => call("/quotes", { method: "POST", body: { requestCode, inrPaise } }).then((r) => r.quote),
  /** Settle. The key belongs to the quote: retries after a lost response MUST reuse it. */
  pay: (quoteId, key) => call("/payments", { method: "POST", body: { quoteId }, headers: { "idempotency-key": key }, timeout: 20000 }),
  payment: (id) => call(`/payments/${encodeURIComponent(id)}`).then((r) => r.payment),
  history: (role, before) => call(`/payments?role=${role}&limit=20${before ? `&before=${encodeURIComponent(before)}` : ""}`),
};

/** One idempotency key per quote, kept until that quote is resolved (survives a refresh). */
export function keyFor(quoteId) {
  const k = `omen.btcinr.key.${quoteId}`;
  try {
    let v = sessionStorage.getItem(k);
    if (!v) sessionStorage.setItem(k, (v = crypto.randomUUID()));
    return v;
  } catch {
    return (keyFor.mem ||= {})[quoteId] ||= crypto.randomUUID();
  }
}
export const forgetKey = (quoteId) => {
  try {
    sessionStorage.removeItem(`omen.btcinr.key.${quoteId}`);
  } catch {
    /* ignore */
  }
};

/**
 * Live updates on /btcinr, with HTTP resync on every (re)connect and polling while disconnected
 * (the contract: socket publication is not device receipt).
 */
export function live(role, { onPayment, onBalance, onExpired, resync, onState = () => {} }) {
  const sock = io("/btcinr", { path: import.meta.env.VITE_SOCKET_PATH || "/socket.io/", addTrailingSlash: !import.meta.env.VITE_SOCKET_PATH, transports: ["websocket"], auth: role === "merchant" ? { role: "merchant" } : { customerToken: guestToken() } });
  let poll = 0;
  const seen = new Set();
  const startPoll = () => (poll ||= setInterval(resync, 4000));
  const stopPoll = () => (clearInterval(poll), (poll = 0));
  sock.on("connect", () => {
    stopPoll();
    onState("live");
    resync();
  });
  sock.on("disconnect", () => {
    onState("reconnecting");
    startPoll();
  });
  sock.on("connect_error", (e) => {
    onState(e?.message === "unauthorized" ? "unauthorized" : "reconnecting");
    startPoll();
  });
  sock.on("btcinr:payment", (m) => {
    const p = m?.payment;
    if (!p || seen.has(`${p.id}:${p.version}`)) return; // delivery may repeat
    seen.add(`${p.id}:${p.version}`);
    onPayment(p);
  });
  sock.on("btcinr:balance", (m) => m?.role === role && onBalance(m.balance, m.version));
  sock.on("btcinr:session-expired", () => onExpired?.());
  return { close: () => (stopPoll(), sock.close()), get connected() {
    return sock.connected;
  } };
}
