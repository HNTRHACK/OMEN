import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaymentService } from "../server/payments.js";
import { Store } from "../server/store.js";
import { S, canTransition, transition } from "../server/stateMachine.js";
import { VerifyError } from "../server/chain.js";
import { merchantQr, MERCHANTS } from "../shared/merchants.js";

const maya = MERCHANTS[0];
const QR = merchantQr(maya, maya.items[0]); // ₹20 cutting chai
const PAYER = "0x1111111111111111111111111111111111111111";
const HASH = "0x" + "ab".repeat(32);

function setup(over = {}) {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const store = new Store(null);
  const calls = { verify: 0 };
  const svc = createPaymentService({
    store,
    rates: async () => ({ rate: "88.00", source: "test" }),
    infer: async () => ({ content: '{"risk":"low","reasons":["registered merchant"],"recommendation":"allow"}', requestId: "zg-123", model: "m", provider: "0g-router" }),
    verify: async () => {
      calls.verify++;
      return { blockNumber: "42", confirmations: 1, payout: PAYER, amount: "1" };
    },
    checkoutConfigured: () => true,
    quoteTtlMs: 120_000,
    now: clock.now,
    ...over,
  });
  return { svc, store, clock, calls };
}

test("state machine only allows listed transitions", () => {
  assert.ok(canTransition(S.QUOTED, S.RISK_ASSESSED));
  assert.ok(!canTransition(S.QUOTED, S.COMPLETED));
  assert.ok(!canTransition(S.COMPLETED, S.FAILED));
  const p = { state: S.QUOTED, history: [] };
  assert.throws(() => transition(p, S.CONFIRMED), /can't go from QUOTED to CONFIRMED/);
});

test("happy path, testnet USDT: quote → risk → authorize → submit → verified → simulated payout", async () => {
  const { svc, calls } = setup();
  let p = await svc.create({ qr: QR, token: "USDT" });
  assert.equal(p.state, S.QUOTED);
  assert.equal(p.quote.inrPaise, 2000);
  assert.equal(p.quote.tokenUnits, "228978"); // (2000+15) paise / 88 INR, rounded up
  p = await svc.risk(p.id);
  assert.equal(p.state, S.RISK_ASSESSED);
  assert.equal(p.risk.ai.requestId, "zg-123");
  p = svc.authorize(p.id, { payer: PAYER });
  assert.equal(p.state, S.AWAITING_WALLET);
  assert.match(p.chain.orderId, /^0x[0-9a-f]{64}$/);
  assert.equal(p.chain.amount, "228978");
  p = await svc.submit(p.id, { txHash: HASH });
  assert.equal(p.state, S.COMPLETED);
  assert.equal(calls.verify, 1);
  assert.equal(p.payout.simulated, true);
  assert.match(p.payout.label, /DEMO INR SETTLEMENT/);
  assert.equal(p.payout.providerRef, null, "no bank/UTR reference is ever invented");
  assert.equal(p.payout.ref, undefined);
  assert.match(p.onchain.explorer, /explorer\.testnet\.whitechain\.io\/tx\/0xabab/);
  assert.deepEqual(
    p.history.map((h) => h.to),
    ["QUOTED", "RISK_ASSESSED", "AWAITING_WALLET", "SUBMITTED", "CONFIRMED", "PAYOUT_SIMULATED", "COMPLETED"],
  );
});

test("DEMO credits complete without any chain call and are labelled", async () => {
  const { svc, calls } = setup();
  let p = await svc.create({ qr: QR, token: "DEMO" });
  assert.equal(p.mode, "demo");
  assert.equal(p.quote.tokenAmount, "20.15");
  p = await svc.risk(p.id);
  p = svc.authorize(p.id, {});
  p = await svc.submit(p.id, { demoRef: "local-1" });
  assert.equal(p.state, S.COMPLETED);
  assert.equal(calls.verify, 0);
  assert.match(p.history.find((h) => h.to === "CONFIRMED").settlement, /DEMO/);
});

test("real USDT is refused for unregistered payees and when checkout is off", async () => {
  const { svc } = setup();
  await assert.rejects(svc.create({ qr: "upi://pay?pa=someone@okbank&pn=Someone&am=10", token: "USDT" }), { code: "unregistered_testnet" });
  const off = setup({ checkoutConfigured: () => false }).svc;
  await assert.rejects(off.create({ qr: QR, token: "USDT" }), { code: "checkout_off" });
  await assert.rejects(svc.create({ qr: QR, token: "BTC" }), { code: "bad_token" });
});

test("static QR needs a valid amount", async () => {
  const { svc } = setup();
  const qr = "upi://pay?pa=maya.chai@blockhaven&pn=Maya's Chai Stall";
  await assert.rejects(svc.create({ qr, token: "DEMO" }), { code: "amount_required" });
  await assert.rejects(svc.create({ qr, token: "DEMO", amountInr: "999999" }), { code: "bad_amount" });
  const p = await svc.create({ qr, token: "DEMO", amountInr: "35" });
  assert.equal(p.quote.inrPaise, 3500);
});

test("spoofed QR is blocked before anything can be signed", async () => {
  const { svc } = setup();
  let p = await svc.create({ qr: "upi://pay?pa=maya.chai@blockhaven&pn=KYC Refund Desk&am=20", token: "DEMO" });
  p = await svc.risk(p.id);
  assert.equal(p.state, S.BLOCKED);
  assert.throws(() => svc.authorize(p.id, {}), { code: "bad_state" });
});

test("review decisions need explicit acknowledgement", async () => {
  const { svc } = setup({ infer: async () => null });
  let p = await svc.create({ qr: "upi://pay?pa=sharma.store@okbank&pn=Sharma Store&am=50", token: "DEMO" });
  p = await svc.risk(p.id);
  assert.equal(p.risk.decision, "review");
  assert.throws(() => svc.authorize(p.id, {}), { code: "needs_ack" });
  assert.equal(svc.authorize(p.id, { acknowledgeRisk: true }).state, S.AWAITING_WALLET);
});

test("quotes expire if not signed in time", async () => {
  const { svc, clock } = setup();
  const p = await svc.create({ qr: QR, token: "USDT" });
  clock.advance(121_000);
  assert.equal(svc.get(p.id).state, S.EXPIRED);
  assert.equal((await svc.risk(p.id)).state, S.EXPIRED, "risk on an expired quote does nothing");
  assert.equal((await svc.risk(p.id)).risk, null);
});

test("testnet authorize requires a wallet address", async () => {
  const { svc } = setup();
  let p = await svc.create({ qr: QR, token: "USDT" });
  p = await svc.risk(p.id);
  assert.throws(() => svc.authorize(p.id, { payer: "nope" }), { code: "bad_payer" });
});

test("a tx hash can only settle one payment", async () => {
  const { svc } = setup();
  const mk = async () => svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "USDT" })).id)).id, { payer: PAYER });
  const a = await mk();
  const b = await mk();
  await svc.submit(a.id, { txHash: HASH });
  await assert.rejects(svc.submit(b.id, { txHash: HASH }), { code: "tx_reused" });
  await assert.rejects(svc.submit(b.id, { txHash: "0x123" }), { code: "bad_hash" });
});

test("pending tx stays SUBMITTED; a bad tx fails and frees the hash", async () => {
  let mode = "pending";
  const { svc } = setup({
    verify: async () => {
      if (mode === "pending") throw new VerifyError("pending", "Not mined yet.", { retry: true });
      throw new VerifyError("wrong_payer", "That payment came from a different wallet.");
    },
  });
  let p = svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "USDT" })).id)).id, { payer: PAYER });
  p = await svc.submit(p.id, { txHash: HASH });
  assert.equal(p.state, S.SUBMITTED);
  assert.equal(p.verifyNote, "Not mined yet.");
  mode = "bad";
  p = await svc.refresh(p.id);
  assert.equal(p.state, S.FAILED);
  // the hash is released, since it didn't pay this order
  const q = svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "USDT" })).id)).id, { payer: PAYER });
  mode = "pending";
  assert.equal((await svc.submit(q.id, { txHash: HASH })).state, S.SUBMITTED);
});

test("cancel is allowed before submit and is a no-op after completion", async () => {
  const { svc } = setup();
  const p = await svc.create({ qr: QR, token: "DEMO" });
  assert.equal(svc.cancel(p.id).state, S.CANCELLED);
  assert.equal((await svc.risk(p.id)).state, S.CANCELLED);
  const done = await svc.submit(svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "DEMO" })).id)).id, {}).id, {});
  assert.equal(svc.cancel(done.id).state, S.COMPLETED);
});

test("audit: a tx reported after the quote expired is still accepted within the grace window", async () => {
  const { svc, clock } = setup();
  let p = svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "USDT" })).id)).id, { payer: PAYER });
  clock.advance(125_000); // quote expired, but the payer's tx may have been mined in time
  assert.equal(svc.get(p.id).state, S.AWAITING_WALLET);
  p = await svc.submit(p.id, { txHash: HASH });
  assert.equal(p.state, S.COMPLETED);
  clock.advance(11 * 60_000);
  const q = svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "USDT" })).id)).id, { payer: PAYER });
  clock.advance(11 * 60_000 + 120_000);
  assert.equal(svc.get(q.id).state, S.EXPIRED, "after the grace window it expires");
});

test("audit: concurrent verification settles exactly once", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { svc, calls } = setup({
    verify: async () => {
      calls.verify++;
      await gate;
      return { blockNumber: "7", confirmations: 1 };
    },
  });
  const calls2 = calls;
  let p = svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "USDT" })).id)).id, { payer: PAYER });
  const a = svc.submit(p.id, { txHash: HASH });
  await new Promise((r) => setImmediate(r));
  const b = svc.refresh(p.id); // a status poll lands while the first verification is in flight
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.state, S.COMPLETED);
  assert.equal(rb.state, S.COMPLETED);
  assert.equal(ra.history.filter((h) => h.to === "CONFIRMED").length, 1);
  assert.ok(calls2.verify >= 1);
});

test("audit: demo and real paths can't be crossed", async () => {
  const { svc, calls } = setup();
  let t = svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "USDT" })).id)).id, { payer: PAYER });
  await assert.rejects(svc.submit(t.id, { demoRef: "x" }), { code: "bad_hash" }); // no "demo" shortcut for USDT
  let d = svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "DEMO" })).id)).id, {});
  d = await svc.submit(d.id, { txHash: HASH });
  assert.equal(d.mode, "demo");
  assert.equal(d.txHash, null, "a DEMO payment never carries a chain tx");
  assert.equal(calls.verify, 0);
});

// ------------------------------------------------------------------ gasless (EIP-3009 relay)
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { forViem } from "../shared/eip3009.js";

const CHECKOUT = "0x9B137463d4E7986D7f535f9B79e28b4EF1938E9b";
function gasless(over = {}) {
  const sent = [];
  const relayer = {
    relay: async (c, sig) => {
      sent.push({ c, sig });
      await new Promise((r) => setTimeout(r, 20));
      return "0x" + String(sent.length).padStart(64, "c");
    },
  };
  return { ...setup({ relayer, checkoutAddress: () => CHECKOUT, ...over }), sent };
}
const signer = privateKeyToAccount(generatePrivateKey());
const authorized = async (svc, who = signer.address) => svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "USDT" })).id)).id, { payer: who });

test("gasless: the payer signs typed data, the relayer settles, the payer sends no transaction", async () => {
  const { svc, sent } = gasless();
  let p = await authorized(svc);
  assert.equal(p.chain.gasless, true);
  const td = p.chain.typedData;
  assert.equal(td.primaryType, "ReceiveWithAuthorization");
  assert.equal(td.domain.name, "Tether USD");
  assert.equal(td.domain.chainId, 1874);
  assert.equal(td.message.to, CHECKOUT, "only the checkout can redeem it");
  assert.equal(td.message.value, p.quote.tokenUnits, "exactly the quoted amount");
  assert.equal(td.message.validBefore, p.chain.deadline);
  const signature = await signer.signTypedData(forViem(td));
  p = await svc.relay(p.id, { signature });
  assert.equal(p.state, "COMPLETED");
  assert.equal(p.relayed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].c.payer, signer.address);
});

test("gasless: a signature from another wallet is refused before any gas is spent", async () => {
  const { svc, sent } = gasless();
  const p = await authorized(svc);
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(svc.relay(p.id, { signature: await other.signTypedData(forViem(p.chain.typedData)) }), { code: "bad_signature" });
  await assert.rejects(svc.relay(p.id, { signature: "0x1234" }), { code: "bad_signature" });
  assert.equal(sent.length, 0);
});

test("gasless: signing different terms (tampered typed data) is refused", async () => {
  const { svc, sent } = gasless();
  const p = await authorized(svc);
  const tampered = { ...p.chain.typedData, message: { ...p.chain.typedData.message, value: "1" } };
  await assert.rejects(svc.relay(p.id, { signature: await signer.signTypedData(forViem(tampered)) }), { code: "bad_signature" });
  assert.equal(sent.length, 0);
});

test("gasless: concurrent relay requests spend relayer gas once", async () => {
  const { svc, sent } = gasless();
  const p = await authorized(svc);
  const signature = await signer.signTypedData(forViem(p.chain.typedData));
  const results = await Promise.allSettled([svc.relay(p.id, { signature }), svc.relay(p.id, { signature })]);
  assert.equal(sent.length, 1, "relayer called exactly once");
  assert.ok(results.some((r) => r.status === "fulfilled" && r.value.state === "COMPLETED"));
  assert.ok(results.some((r) => r.status === "rejected" && r.reason.code === "in_progress"));
  // a later retry is idempotent
  assert.equal((await svc.relay(p.id, { signature })).state, "COMPLETED");
  assert.equal(sent.length, 1);
});

test("gasless: expired quote is refused; no relayer means a clear error", async () => {
  const { svc, clock } = gasless();
  const p = await authorized(svc);
  const signature = await signer.signTypedData(forViem(p.chain.typedData));
  clock.advance(121_000);
  await assert.rejects(svc.relay(p.id, { signature }), { code: "expired" });
  const plain = setup().svc; // no relayer configured
  const q = await authorized(plain);
  assert.equal(q.chain.gasless, false);
  await assert.rejects(plain.relay(q.id, { signature }), { code: "relayer_off" });
});

test("gasless: listeners hear every state change", async () => {
  const seen = [];
  const { svc } = gasless({ onChange: (p) => seen.push(p.state) });
  const p = await authorized(svc);
  await svc.relay(p.id, { signature: await signer.signTypedData(forViem(p.chain.typedData)) });
  assert.deepEqual([...new Set(seen)], ["QUOTED", "RISK_ASSESSED", "AWAITING_WALLET", "SUBMITTED", "COMPLETED"]);
});

test("gasless: JS nonce matches Solidity abi.encode (value pinned from Foundry's cast)", async () => {
  const { authorizationNonce } = await import("../shared/eip3009.js");
  const { merchantKey } = await import("../shared/merchants.js");
  const n = authorizationNonce("0x9B137463d4E7986D7f535f9B79e28b4EF1938E9b", {
    orderId: "0x" + "ab".repeat(32), merchantKey: merchantKey("maya-chai"), amount: "640293", inrPaise: "6000", deadline: "1800000120",
  });
  assert.equal(n, "0xbf3b2c2251b6e8d165f9386aab18809e038d814f04c9499c82c7c25df2415794");
});

test("off-ramp: a real provider must confirm before INR counts as settled", async () => {
  const pending = { name: "acme-payouts", real: true, payout: async () => ({ status: "pending" }) };
  let { svc } = setup({ offramp: pending });
  let p = await svc.submit(svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "DEMO" })).id)).id, {}).id, {});
  assert.equal(p.state, "CONFIRMED", "crypto confirmed, INR not settled: the order is not completed");
  assert.equal(p.payout.status, "pending");
  const settled = { name: "acme-payouts", real: true, payout: async () => ({ status: "settled", providerRef: "ACME-123" }) };
  ({ svc } = setup({ offramp: settled }));
  p = await svc.submit(svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "DEMO" })).id)).id, {}).id, {});
  assert.equal(p.state, "COMPLETED");
  assert.equal(p.payout.providerRef, "ACME-123", "only the provider's own reference is shown");
  const liar = { name: "fake", real: false, payout: async () => ({ status: "settled", providerRef: "MADE-UP" }) };
  ({ svc } = setup({ offramp: liar }));
  p = await svc.submit(svc.authorize((await svc.risk((await svc.create({ qr: QR, token: "DEMO" })).id)).id, {}).id, {});
  assert.equal(p.payout.real, false);
  assert.equal(p.payout.providerRef, null, "a non-authorized provider can never mark INR settled");
});
