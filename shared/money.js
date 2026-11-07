// Integer-only money maths. INR in paise (Number, safe well past our caps); token amounts in
// base units (BigInt). Every rounding goes in the merchant's favour, so the INR the merchant is
// quoted is always covered.

export const FEE_BPS = 75; // 0.75% gateway fee, shown to the payer before they approve

/** "88.4371" INR per token → paise per whole token, as BigInt with 4 extra digits of precision. */
export function rateToMicroPaise(rate) {
  const s = String(rate);
  if (!/^\d{1,6}(\.\d{1,8})?$/.test(s)) throw new Error("bad rate");
  const [i, f = ""] = s.split(".");
  // INR → paise is ×100; keep 4 more digits: ×1e6 total
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Quote what the payer is charged for the merchant to receive `inrPaise`.
 * @param {number} inrPaise   what the merchant receives
 * @param {string} rate       INR per 1 whole token (e.g. "88.42")
 * @param {number} decimals   token decimals
 */
export function quote(inrPaise, rate, decimals, feeBps = FEE_BPS) {
  if (!Number.isSafeInteger(inrPaise) || inrPaise <= 0) throw new Error("bad amount");
  const feePaise = Math.ceil((inrPaise * feeBps) / 10_000);
  const totalPaise = inrPaise + feePaise;
  const micro = rateToMicroPaise(rate); // paise ×1e4 per token
  if (micro === 0n) throw new Error("bad rate");
  // tokenUnits = totalPaise / (paise per token) × 10^dec = totalPaise × 1e4 × 10^dec / micro
  const tokenUnits = ceilDiv(BigInt(totalPaise) * 10_000n * 10n ** BigInt(decimals), micro);
  return { inrPaise, feePaise, totalPaise, feeBps, rate: String(rate), tokenUnits, decimals };
}

/** 2500000n, 6 → "2.5" */
export function formatUnits(units, decimals, maxFrac = 6) {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = u / base;
  let frac = (u % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
