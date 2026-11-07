import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommerce } from "../server/commerce.js";
import { createPaymentService } from "../server/payments.js";
import { Store } from "../server/store.js";
import { directMerchantId, merchantKey } from "../shared/merchants.js";

const ASHA = "a".repeat(24);
const RAVI = "b".repeat(24);
const CEE = "c".repeat(24);
const PAYOUT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function world() {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const sent = [];
  const notify = { player: (id, ev, d) => sent.push({ to: id, ev, d }), all: (ev, d) => sent.push({ to: "*", ev, d }) };
  let commerce;
  const payments = createPaymentService({
    store: new Store(null),
    rates: async () => ({ rate: "88.00", source: "test" }),
    infer: async () => null,
    verify: async () => ({ blockNumber: "1", confirmations: 1 }),
    checkoutConfigured: () => true,
    now: clock.now,
    onChange: (p) => commerce?.onPayment(p),
  });
  commerce = createCommerce({ payments, notify, now: clock.now });
  return { commerce, payments, sent, clock };
}
/** Pay a just-created order's payment with DEMO credits, the way the browser does. */
async function payDemo(payments, payment) {
  const p = payments.authorize(payment.id, {});
  return payments.submit(p.id, { demoRef: "test" });
}

test("claiming: one stall per courier, vacant stalls only, names cleaned", async () => {
  const { commerce } = world();
  const s = commerce.claim(ASHA, "plot-west", { name: "  <b>Asha's</b> Spices‮  " }, "Asha");
  assert.equal(s.name, "bAsha's/b Spices");
  assert.throws(() => commerce.claim(RAVI, "plot-west", {}), { code: "taken" });
  assert.throws(() => commerce.claim(ASHA, "plot-east", {}), { code: "one_shop" });
  assert.throws(() => commerce.claim(null, "plot-east", {}), { code: "no_identity" });
  assert.throws(() => commerce.claim(RAVI, "plot-nowhere", {}), { code: "not_found" });
  assert.equal(commerce.list().plots.find((p) => p.plot === "plot-west").shop.owner, ASHA);
});

test("only the owner can edit a shop or its products", async () => {
  const { commerce } = world();
  commerce.claim(ASHA, "plot-west", { name: "Spices" });
  assert.throws(() => commerce.update(RAVI, "plot-west", { name: "Mine now" }), { code: "not_owner" });
  assert.throws(() => commerce.upsertProduct(RAVI, "plot-west", { name: "Fake", price: "1" }), { code: "not_owner" });
  const s = commerce.upsertProduct(ASHA, "plot-west", { name: "Cardamom", price: "45.50", stock: 3 });
  assert.equal(s.products[0].pricePaise, 4550);
  assert.throws(() => commerce.upsertProduct(ASHA, "plot-west", { name: "Gold", price: "99999" }), { code: "bad_price" });
  assert.throws(() => commerce.update(ASHA, "plot-west", { payout: "0xnope" }), { code: "bad_payout" });
});

test("B2C with DEMO credits: order paid, stock decremented, seller and buyer notified, fulfilment simulated", async () => {
  const { commerce, payments, sent } = world();
  commerce.claim(ASHA, "plot-west", { name: "Spices" }, "Asha");
  const pid = commerce.upsertProduct(ASHA, "plot-west", { name: "Cardamom", price: "45.50", stock: 3 }).products[0].id;
  const { order, payment } = await commerce.order(RAVI, "Ravi", { shopId: "plot-west", items: [{ productId: pid, qty: 2 }], token: "DEMO" });
  assert.equal(order.status, "pending_payment");
  assert.equal(payment.quote.inrPaise, 9100);
  assert.equal(payment.state, "RISK_ASSESSED");
  assert.equal(commerce.list().plots[0].shop.products[0].available, 1, "2 reserved while unpaid");
  await payDemo(payments, payment);
  const paid = commerce.shopOrders(ASHA, "plot-west")[0];
  assert.equal(paid.status, "paid");
  assert.equal(paid.buyerName, "Ravi");
  assert.equal(commerce.list().plots[0].shop.products[0].stock, 1);
  assert.ok(sent.some((n) => n.to === ASHA && n.ev === "shop:order" && n.d.id === order.id), "seller notified in real time");
  assert.ok(sent.some((n) => n.to === RAVI && n.ev === "order:update"));
  assert.throws(() => commerce.fulfil(RAVI, order.id), { code: "not_owner" });
  assert.equal(commerce.fulfil(ASHA, order.id).fulfillment, "simulated");
});

test("stock: can't buy more than is available, including reservations; can't buy from yourself", async () => {
  const { commerce } = world();
  commerce.claim(ASHA, "plot-west", { name: "Spices" });
  const pid = commerce.upsertProduct(ASHA, "plot-west", { name: "Saffron", price: "100", stock: 1 }).products[0].id;
  await commerce.order(RAVI, "Ravi", { shopId: "plot-west", items: [{ productId: pid, qty: 1 }], token: "DEMO" });
  await assert.rejects(commerce.order(CEE, "Cee", { shopId: "plot-west", items: [{ productId: pid, qty: 1 }], token: "DEMO" }), { code: "out_of_stock" });
  await assert.rejects(commerce.order(ASHA, "Asha", { shopId: "plot-west", items: [{ productId: pid, qty: 1 }], token: "DEMO" }), { code: "own_shop" });
  await assert.rejects(commerce.order(CEE, "Cee", { shopId: "plot-west", items: [{ productId: pid, qty: 99 }], token: "DEMO" }), { code: "bad_qty" });
});

test("abandoned checkouts release their stock when the quote expires", async () => {
  const { commerce, clock } = world();
  commerce.claim(ASHA, "plot-west", { name: "Spices" });
  const pid = commerce.upsertProduct(ASHA, "plot-west", { name: "Saffron", price: "100", stock: 1 }).products[0].id;
  const { order } = await commerce.order(RAVI, "Ravi", { shopId: "plot-west", items: [{ productId: pid, qty: 1 }], token: "DEMO" });
  clock.advance(5 * 60_000);
  commerce.sweep();
  assert.equal(commerce._db.orders.get(order.id).status, "cancelled");
  assert.equal(commerce.list().plots[0].shop.products[0].available, 1, "reservation released");
});

test("testnet USDT needs a payout wallet, and pays the shop's direct on-chain merchant id", async () => {
  const { commerce, payments } = world();
  commerce.claim(ASHA, "plot-west", { name: "Spices" });
  const pid = commerce.upsertProduct(ASHA, "plot-west", { name: "Saffron", price: "100", stock: 5 }).products[0].id;
  await assert.rejects(commerce.order(RAVI, "Ravi", { shopId: "plot-west", items: [{ productId: pid, qty: 1 }], token: "USDT" }), { code: "no_payout" });
  commerce.update(ASHA, "plot-west", { payout: PAYOUT });
  const { payment } = await commerce.order(RAVI, "Ravi", { shopId: "plot-west", items: [{ productId: pid, qty: 1 }], token: "USDT" });
  const a = payments.authorize(payment.id, { payer: "0x1111111111111111111111111111111111111111" });
  assert.equal(a.chain.merchantKey, directMerchantId(PAYOUT), "settles straight to the shop owner's wallet");
});

test("NPC shops sell through their registered on-chain merchant", async () => {
  const { commerce, payments } = world();
  assert.deepEqual(commerce.list().npc.map((s) => s.id), ["maya-chai", "orin-relay"]);
  const { payment } = await commerce.order(RAVI, "Ravi", { shopId: "maya-chai", items: [{ productId: "masala", qty: 1 }], token: "USDT" });
  const a = payments.authorize(payment.id, { payer: "0x1111111111111111111111111111111111111111" });
  assert.equal(a.chain.merchantKey, merchantKey("maya-chai"));
  assert.equal(payment.quote.inrPaise, 6000);
});

test("B2B: one shop invoices another; only the invoiced owner can pay; paid on settlement", async () => {
  const { commerce, payments, sent } = world();
  commerce.claim(ASHA, "plot-west", { name: "Spices" });
  commerce.claim(RAVI, "plot-east", { name: "Ravi's Teas" });
  const inv = commerce.invoice(ASHA, { fromShopId: "plot-west", toShopId: "plot-east", lines: [{ name: "Cardamom, wholesale", qty: 10, price: "40" }], memo: "Festival stock" });
  assert.equal(inv.totalPaise, 40000);
  assert.ok(sent.some((n) => n.to === RAVI && n.ev === "invoice:new"));
  await assert.rejects(commerce.payInvoice(CEE, inv.id, { token: "DEMO" }), { code: "not_payee" });
  assert.throws(() => commerce.invoice(ASHA, { fromShopId: "plot-east", toShopId: "plot-west", lines: [{ name: "x y", qty: 1, price: "1" }] }), { code: "not_owner" });
  const { order, payment } = await commerce.payInvoice(RAVI, inv.id, { token: "DEMO" });
  assert.equal(order.kind, "b2b");
  await assert.rejects(commerce.payInvoice(RAVI, inv.id, { token: "DEMO" }), { code: "in_progress" });
  await payDemo(payments, payment);
  assert.equal(commerce.myInvoices(ASHA).sent[0].status, "paid");
  assert.ok(sent.some((n) => n.to === ASHA && n.ev === "shop:order" && n.d.kind === "b2b"));
  assert.throws(() => commerce.cancelInvoice(ASHA, inv.id), { code: "not_open" });
});

test("over HTTP: identity from x-omen-token; no token, no shop", async () => {
  const { createServer } = await import("node:http");
  const { createApp } = await import("../server/index.js");
  const { randomBytes } = await import("node:crypto");
  const { commerce, payments } = world();
  const srv = createServer(createApp({ service: payments, publicConfig: () => ({}), commerce }));
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const asha = randomBytes(32).toString("hex");
  const call = (path, body, token) => fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { "x-omen-token": token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call("/api/shops/plot-west/claim", { name: "Spices" })).status, 401);
    const claimed = await (await call("/api/shops/plot-west/claim", { name: "Spices", ownerName: "Asha" }, asha)).json();
    assert.equal(claimed.name, "Spices");
    const mine = await (await call("/api/shops/mine", null, asha)).json();
    assert.equal(mine.shop.id, "plot-west");
    assert.equal((await call("/api/shops/plot-west", { name: "Stolen" }, randomBytes(32).toString("hex"))).status, 403);
    const listed = await (await call("/api/shops")).json();
    assert.equal(listed.plots.find((p) => p.plot === "plot-west").shop.name, "Spices");
    assert.equal(JSON.stringify(listed).includes(asha), false, "the secret token never appears in public data");
  } finally {
    srv.close();
  }
});
