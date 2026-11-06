import { test } from "node:test";
import assert from "node:assert/strict";
import { recordValues, paymentRecord, fitBytes } from "../shared/arkivRecord.js";

test("fitBytes never exceeds Arkiv's 128-byte str limit or splits characters", () => {
  assert.equal(fitBytes("chai", 128), "chai");
  const s = fitBytes("☕".repeat(100), 128); // ☕ is 3 bytes
  assert.equal(new TextEncoder().encode(s).length, 126);
  assert.equal(s, "☕".repeat(42));
});

test("payment → record values validate through the real SDK constructors", () => {
  const p = {
    id: "3f1e2d4c-0000-4000-8000-000000000000",
    mode: "testnet",
    state: "COMPLETED",
    createdAt: 1_762_400_000_000,
    upi: { vpa: "maya.chai@blockhaven", note: "Cutting chai ".repeat(20) },
    merchant: { id: "maya-chai", name: "Maya's Chai Stall" },
    quote: { inrPaise: 2000, token: "USDT", tokenAmount: "0.228978" },
    txHash: "0x" + "ab".repeat(32),
    risk: { ai: { requestId: "zg-req-1" } },
    payout: { ref: "SIM-ABCDEF" },
  };
  const v = recordValues(paymentRecord(p));
  assert.equal(v.kind.value, "payment");
  assert.equal(v.createdAt.value, 1_762_400_000_000n);
  assert.equal(v.inrPaise.type, "u64");
  assert.equal(v.payout.value, "SIMULATED SIM-ABCDEF");
  assert.ok(new TextEncoder().encode(v.note.value).length <= 128);
});

test("rejects unknown kinds/modes", () => {
  assert.throws(() => recordValues({ kind: "x", mode: "demo" }));
  assert.throws(() => recordValues({ kind: "payment", mode: "mainnet" }));
});

test("audit: a real-world payee's UPI ID and note never reach public Arkiv", () => {
  const v = recordValues(
    paymentRecord({
      id: "x", mode: "demo", state: "COMPLETED", createdAt: 1,
      upi: { vpa: "ravi.kumar@okbank", note: "rent for flat 4B" },
      merchant: null, quote: { inrPaise: 100, token: "DEMO", tokenAmount: "1.01" },
    }),
  );
  assert.equal(v.merchant.value, "external");
  assert.equal(v.note.value, "");
  assert.ok(!JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x)).includes("ravi"));
});
