// The two-phone payment frontend's money display and QR handling (src/btcinr/money.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPaise, formatSats, formatRate, parseInr, codeFromQr } from "../src/btcinr/money.js";

test("exact money display: paise, satoshis and rates, no floating point", () => {
  assert.equal(formatPaise(25000), "₹250.00");
  assert.equal(formatPaise(1), "₹0.01");
  assert.equal(formatPaise(123456789), "₹12,34,567.89");
  assert.equal(formatPaise(1000000), "₹10,000.00");
  assert.equal(formatSats("4360"), "0.00004360");
  assert.equal(formatSats("1000000"), "0.01000000");
  assert.equal(formatSats("2100000000000000"), "21000000.00000000");
  assert.equal(formatRate("5734210.55"), "₹57,34,210.55");
  assert.equal(formatRate("100"), "₹100.00");
});

test("typed rupees parse to integer paise exactly; anything odd is refused", () => {
  assert.equal(parseInr("250"), 25000);
  assert.equal(parseInr("250.5"), 25050);
  assert.equal(parseInr("1,250.50"), 125050);
  assert.equal(parseInr("₹ 0.01"), 1);
  assert.equal(parseInr("0.1"), 10);
  assert.equal(parseInr("0.29"), 29, "no 0.29*100 = 28.999… rounding bugs");
  for (const bad of ["", "0", "-5", "1.234", "abc", "1e3", "12.3.4"]) assert.equal(parseInr(bad), null, bad);
});

test("QR codes: only this site's pay link or omenpay:, never another origin", () => {
  const o = "https://omen.example";
  assert.equal(codeFromQr(`${o}/pay.html#/r/rq_abc123`, o), "rq_abc123");
  assert.equal(codeFromQr("omenpay:r/rq_abc123", o), "rq_abc123");
  assert.equal(codeFromQr("https://evil.example/pay.html#/r/rq_abc123", o), null);
  assert.equal(codeFromQr(`${o}/other.html#/r/rq_abc123`, o), null);
  assert.equal(codeFromQr(`${o}/pay.html#/r/bad code`, o), null);
  assert.equal(codeFromQr("rq_abc123", o), "rq_abc123", "a typed code");
  assert.equal(codeFromQr("upi://pay?pa=x@y", o), null);
});
