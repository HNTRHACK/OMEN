import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpiQr, buildUpiQr, inrToPaise, UpiError } from "../shared/upi.js";
import { quote, formatUnits, rateToMicroPaise } from "../shared/money.js";
import { MERCHANTS, merchantQr, merchantKey } from "../shared/merchants.js";

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof UpiError, `expected UpiError, got ${e}`);
    return e.code;
  }
  assert.fail("did not throw");
};

test("parses a standard UPI QR", () => {
  const u = parseUpiQr("upi://pay?pa=Maya.Chai@blockhaven&pn=Maya%27s%20Chai%20Stall&am=40.50&cu=INR&tn=Festival&mc=5814");
  assert.equal(u.vpa, "maya.chai@blockhaven");
  assert.equal(u.name, "Maya's Chai Stall");
  assert.equal(u.amountPaise, 4050);
  assert.equal(u.note, "Festival");
  assert.equal(u.mcc, "5814");
});

test("QR without an amount is allowed (static merchant QR)", () => {
  assert.equal(parseUpiQr("upi://pay?pa=shop@okbank&pn=Shop").amountPaise, null);
});

test("rejects non-UPI, bad payees, other currencies and bad amounts", () => {
  assert.equal(code(() => parseUpiQr("https://evil.example")), "not_upi");
  assert.equal(code(() => parseUpiQr("")), "empty");
  assert.equal(code(() => parseUpiQr("upi://pay?pn=x")), "no_payee");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=not-a-vpa")), "bad_vpa");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&cu=USD")), "bad_currency");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&am=1e3")), "bad_amount");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&am=-5")), "bad_amount");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&am=0")), "bad_amount");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&am=1.234")), "bad_amount");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&am=10000.01")), "too_much");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&pn=%E0%A4%A")), "bad_encoding");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&tn=" + "x".repeat(1100))), "too_long");
});

test("rejects repeated payee/amount parameters (parameter pollution)", () => {
  assert.equal(code(() => parseUpiQr("upi://pay?pa=maya.chai@blockhaven&pa=thief@bank")), "duplicate_param");
  assert.equal(code(() => parseUpiQr("upi://pay?pa=a.b@bank&am=1&AM=900")), "duplicate_param");
});

test("strips control and bidi-override characters from display fields", () => {
  const u = parseUpiQr("upi://pay?pa=a.b@bank&pn=Ma%E2%80%AEya%00%0A");
  assert.equal(u.name, "Maya");
});

test("merchant QR codes round-trip", () => {
  for (const m of MERCHANTS)
    for (const it of m.items) {
      const u = parseUpiQr(merchantQr(m, it));
      assert.equal(u.vpa, m.vpa);
      assert.equal(u.name, m.name);
      assert.equal(u.amountPaise, it.paise);
    }
  assert.equal(parseUpiQr(buildUpiQr({ vpa: "x.y@zz", name: "A & B" })).name, "A & B");
  assert.match(merchantKey("maya-chai"), /^0x[0-9a-f]{64}$/);
});

test("inrToPaise is exact", () => {
  assert.equal(inrToPaise("0.1"), 10);
  assert.equal(inrToPaise("19.99"), 1999);
  assert.equal(inrToPaise("7"), 700);
});

test("quote: fee and rounding favour the merchant", () => {
  const q = quote(2000, "88.42", 6); // ₹20 chai
  assert.equal(q.feePaise, 15); // 0.75% of ₹20 = 15 paise
  assert.equal(q.totalPaise, 2015);
  // 20.15 / 88.42 = 0.2278896… USDT → rounded UP to 0.227890
  assert.equal(q.tokenUnits, 227890n);
  // paying tokenUnits at the rate covers the total
  assert.ok((q.tokenUnits * rateToMicroPaise("88.42")) / 10n ** 6n / 10_000n >= 2015n - 1n);
  assert.equal(formatUnits(q.tokenUnits, 6), "0.22789");
});

test("quote: DEMO credits are 1:1 with rupees", () => {
  const q = quote(80000, "1", 2);
  assert.equal(q.feePaise, 600);
  assert.equal(q.tokenUnits, 80600n);
  assert.equal(formatUnits(q.tokenUnits, 2), "806");
});

test("quote rejects nonsense", () => {
  assert.throws(() => quote(0, "88", 6));
  assert.throws(() => quote(1.5, "88", 6));
  assert.throws(() => quote(100, "abc", 6));
  assert.throws(() => quote(100, "0", 6));
});

test("formatUnits", () => {
  assert.equal(formatUnits(1_000_000_00n, 2), "1,000,000");
  assert.equal(formatUnits(5n, 6), "0.000005");
  assert.equal(formatUnits(-150n, 2), "-1.5");
});
