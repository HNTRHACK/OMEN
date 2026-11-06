// The payment lifecycle. Every change goes through `transition`, which refuses any move the
// table doesn't allow and appends to the payment's audit trail.
//
//   QUOTED ─► RISK_ASSESSED ─► AWAITING_WALLET ─► SUBMITTED ─► CONFIRMED ─► PAYOUT_SIMULATED ─► COMPLETED
//     │            │                 │                │
//     └► EXPIRED   ├► BLOCKED        ├► EXPIRED       └► FAILED
//     └► CANCELLED └► EXPIRED/CANC.  └► CANCELLED/FAILED
//
// PAYOUT_SIMULATED is honest by name: OMEN has no licensed INR payout partner, so the rupee leg
// is simulated and labelled as such everywhere it appears.

export const S = Object.freeze({
  QUOTED: "QUOTED",
  RISK_ASSESSED: "RISK_ASSESSED",
  AWAITING_WALLET: "AWAITING_WALLET",
  SUBMITTED: "SUBMITTED",
  CONFIRMED: "CONFIRMED",
  PAYOUT_SIMULATED: "PAYOUT_SIMULATED",
  COMPLETED: "COMPLETED",
  BLOCKED: "BLOCKED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
});

const T = {
  QUOTED: ["RISK_ASSESSED", "BLOCKED", "EXPIRED", "CANCELLED"],
  RISK_ASSESSED: ["AWAITING_WALLET", "BLOCKED", "EXPIRED", "CANCELLED"],
  AWAITING_WALLET: ["SUBMITTED", "EXPIRED", "CANCELLED", "FAILED"],
  SUBMITTED: ["CONFIRMED", "FAILED"],
  CONFIRMED: ["PAYOUT_SIMULATED"],
  PAYOUT_SIMULATED: ["COMPLETED"],
  COMPLETED: [],
  BLOCKED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
};

export const TERMINAL = new Set(["COMPLETED", "BLOCKED", "EXPIRED", "CANCELLED", "FAILED"]);
/** States in which a stale quote can still be expired (nothing has been signed yet). */
export const EXPIRABLE = new Set(["QUOTED", "RISK_ASSESSED", "AWAITING_WALLET"]);

export class TransitionError extends Error {
  constructor(from, to) {
    super(`A payment can't go from ${from} to ${to}.`);
    this.code = "bad_transition";
    this.status = 409;
  }
}

export const canTransition = (from, to) => (T[from] || []).includes(to);

export function transition(p, to, detail = {}, now = Date.now()) {
  if (!canTransition(p.state, to)) throw new TransitionError(p.state, to);
  p.history.push({ from: p.state, to, at: now, ...detail });
  p.state = to;
  p.updatedAt = now;
  return p;
}

/**
 * After a testnet order is authorized the payer may already have a valid tx in flight. The
 * contract refuses payment after the deadline, so any tx that succeeds was paid in time; this grace
 * only gives a slow *report* of such a tx time to reach the gateway instead of orphaning it.
 */
export const SUBMIT_GRACE_MS = 10 * 60_000;

/** Expire the payment if its quote is stale and nothing has been signed. Returns true if it did. */
export function expireIfStale(p, now = Date.now()) {
  const limit = p.state === "AWAITING_WALLET" && p.chain ? p.quote.expiresAt + SUBMIT_GRACE_MS : p.quote.expiresAt;
  if (EXPIRABLE.has(p.state) && now > limit) {
    transition(p, S.EXPIRED, { reason: "Quote expired before the payment was signed." }, now);
    return true;
  }
  return false;
}
