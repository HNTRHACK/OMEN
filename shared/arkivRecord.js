// The Arkiv record schema and a builder that turns an OMEN payment/delivery into validated values.
// Pure (no browser APIs) so it is unit-tested in Node with the real SDK validators.
import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";

/** One record per payment or courier delivery. Documented in /arkiv/schema.md. */
export const Record = defineSchema("omen.record.v1", {
  kind: str().indexed(), // "payment" | "delivery"
  mode: str().indexed(), // "testnet" | "demo" (payments) | "story" (deliveries)
  merchant: str().indexed(), // merchant slug, or the delivery recipient
  status: str().indexed(), // final payment state, or "delivered"
  ref: str().indexed(), // OMEN payment id / delivery id
  createdAt: u64().indexed(), // unix ms
  inrPaise: u64(),
  token: str(),
  amount: str(),
  whitechainTx: str(),
  zgRequestId: str(),
  payout: str(), // "DEMO INR SETTLEMENT", or a real payout provider's reference
  note: str(),
});

const KINDS = new Set(["payment", "delivery"]);
const MODES = new Set(["testnet", "demo", "story"]);
const enc = new TextEncoder();

/** Truncate to at most `max` UTF-8 bytes without splitting a character (Arkiv: 128 bytes per str). */
export function fitBytes(s, max = 128) {
  let out = "";
  let n = 0;
  for (const ch of String(s ?? "")) {
    const b = enc.encode(ch).length;
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/** Build validated Arkiv values. Throws (via the SDK's constructors) on anything invalid. */
export function recordValues(r) {
  if (!KINDS.has(r.kind)) throw new Error(`bad kind ${r.kind}`);
  if (!MODES.has(r.mode)) throw new Error(`bad mode ${r.mode}`);
  const s = (v, max) => str(fitBytes(v, max));
  return {
    kind: str(r.kind),
    mode: str(r.mode),
    merchant: s(r.merchant, 64),
    status: s(r.status, 32),
    ref: s(r.ref, 64),
    createdAt: u64(BigInt(r.createdAt ?? Date.now())),
    inrPaise: u64(BigInt(r.inrPaise ?? 0)),
    token: s(r.token, 16),
    amount: s(r.amount, 40),
    whitechainTx: s(r.whitechainTx, 66),
    zgRequestId: s(r.zgRequestId, 128),
    payout: s(r.payout, 64),
    note: s(r.note, 128),
  };
}

/**
 * A completed gateway payment → record fields. Arkiv entities are public, so a payee that isn't a
 * registered (fictional) Blockhaven merchant is recorded as "external": a real person's UPI ID or
 * their QR's note never goes on-chain.
 */
export function paymentRecord(p) {
  const known = !!p.merchant?.id;
  return {
    kind: "payment",
    mode: p.mode,
    merchant: known ? p.merchant.id : "external",
    status: p.state,
    ref: p.id,
    createdAt: p.createdAt,
    inrPaise: p.quote.inrPaise,
    token: p.quote.token,
    amount: p.quote.tokenAmount,
    whitechainTx: p.txHash || "",
    zgRequestId: p.risk?.ai?.requestId || "",
    // Only a real provider's reference is ever recorded; demo settlements say so and nothing more.
    payout: p.payout ? (p.payout.real && p.payout.providerRef ? `INR ${p.payout.providerRef}` : "DEMO INR SETTLEMENT") : "",
    note: known ? p.upi.note || p.merchant.name : "",
  };
}
