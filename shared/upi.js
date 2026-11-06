// UPI QR parsing (NPCI "upi://pay" deep-link format) with strict validation.
// QR contents are attacker-controlled, so everything here is defensive: known keys only once,
// bounded lengths, INR only, and no control characters.

export const MAX_INR_PAISE = 1_000_000; // ₹10,000 per payment in this demo gateway
const VPA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const AMOUNT_RE = /^\d{1,7}(\.\d{1,2})?$/;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g; // incl. bidi overrides
// Keys that must not repeat: a second "pa" or "am" is a classic way to show one payee and pay another.
const SINGLE = ["pa", "pn", "am", "cu", "tn", "tr", "mc", "mam", "tid", "url", "mode", "purpose", "orgid", "sign"];

export class UpiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const clean = (s, max) => String(s ?? "").replace(CTRL_RE, "").trim().slice(0, max);

/** "40" | "40.5" | "40.50" → 4050 paise. Throws on anything else. */
export function inrToPaise(text) {
  const s = String(text ?? "").trim();
  if (!AMOUNT_RE.test(s)) throw new UpiError("bad_amount", "Amount must be a number with at most 2 decimals.");
  const [r, f = ""] = s.split(".");
  return Number(r) * 100 + Number(f.padEnd(2, "0"));
}

export const formatInr = (paise) =>
  "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Parse a scanned QR string. Returns { vpa, name, amountPaise|null, note, ref, mcc, raw }.
 * @throws {UpiError}
 */
export function parseUpiQr(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new UpiError("empty", "The QR code is empty.");
  if (raw.length > 1024) throw new UpiError("too_long", "This QR code is too long to be a UPI payment code.");
  const m = /^upi:\/\/pay\?(.*)$/i.exec(raw);
  if (!m) throw new UpiError("not_upi", "This isn't a UPI payment QR (it should start with upi://pay).");

  const seen = new Map();
  for (const part of m[1].split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeSafe(eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    const v = eq < 0 ? "" : decodeSafe(part.slice(eq + 1));
    if (seen.has(k) && SINGLE.includes(k)) throw new UpiError("duplicate_param", `The QR repeats "${k}", which can hide the real payee. Refusing it.`);
    seen.set(k, v);
  }

  const vpa = clean(seen.get("pa"), 320);
  if (!vpa) throw new UpiError("no_payee", "The QR has no payee address (pa).");
  if (!VPA_RE.test(vpa)) throw new UpiError("bad_vpa", "The payee UPI ID is not valid.");

  const cu = seen.get("cu");
  if (cu !== undefined && cu.toUpperCase() !== "INR") throw new UpiError("bad_currency", "Only INR UPI codes are supported.");

  let amountPaise = null;
  const am = seen.get("am");
  if (am !== undefined && am !== "") {
    amountPaise = inrToPaise(am);
    if (amountPaise <= 0) throw new UpiError("bad_amount", "The amount must be more than zero.");
    if (amountPaise > MAX_INR_PAISE) throw new UpiError("too_much", `This demo gateway caps payments at ${formatInr(MAX_INR_PAISE)}.`);
  }

  return {
    vpa: vpa.toLowerCase(),
    name: clean(seen.get("pn"), 99),
    amountPaise,
    note: clean(seen.get("tn"), 80),
    ref: clean(seen.get("tr"), 35),
    mcc: clean(seen.get("mc"), 4),
    raw,
  };
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    throw new UpiError("bad_encoding", "The QR code is badly encoded.");
  }
}

/** Build a UPI QR string (used for the in-game merchant signs). */
export function buildUpiQr({ vpa, name, amountPaise, note, mcc }) {
  const p = [`pa=${encodeURIComponent(vpa)}`, `pn=${encodeURIComponent(name)}`];
  if (mcc) p.push(`mc=${mcc}`);
  if (amountPaise) p.push(`am=${(amountPaise / 100).toFixed(2)}`);
  p.push("cu=INR");
  if (note) p.push(`tn=${encodeURIComponent(note)}`);
  return `upi://pay?${p.join("&")}`;
}
