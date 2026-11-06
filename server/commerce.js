// Blockhaven's shared economy: player-owned shops (B2C), invoices between shops (B2B) and the NPC
// shops (Maya, Orin). Payment goes through the same pipeline as a scanned QR (quote → safety check
// → gasless Whitechain USDT or DEMO credits → on-chain verification); this module only turns a
// confirmed payment into a paid order. Fulfilment is simulated and labelled as such.
import { randomUUID } from "node:crypto";
import { isAddress, getAddress } from "viem";
import { Collection } from "./db.js";
import { ApiError } from "./payments.js";
import { PLOTS, plotById, SHOP_COLORS } from "../shared/storefronts.js";
import { MERCHANTS, merchantById, merchantKey, directMerchantId } from "../shared/merchants.js";
import { inrToPaise, MAX_INR_PAISE } from "../shared/upi.js";

const MAX_PRODUCTS = 12;
const MAX_QTY = 20;
const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>]/g;
export const clean = (s, max) => String(s ?? "").normalize("NFKC").replace(CTRL, "").trim().slice(0, max);
const bad = (code, msg, status = 400) => new ApiError(status, code, msg);
const PAID = new Set(["paid", "fulfilled"]);

function price(text) {
  let p;
  try {
    p = inrToPaise(text);
  } catch {
    throw bad("bad_price", "Prices are rupees with at most 2 decimals, like 60 or 49.50.");
  }
  if (p <= 0 || p > MAX_INR_PAISE) throw bad("bad_price", "Prices must be between ₹0.01 and ₹10,000.");
  return p;
}

export function createCommerce({ dir = null, payments, notify = { player() {}, all() {} }, now = () => Date.now() } = {}) {
  const shops = new Collection(dir, "shops");
  const orders = new Collection(dir, "orders");
  const invoices = new Collection(dir, "invoices");

  // ---------------------------------------------------------------- views
  const npcShops = () =>
    MERCHANTS.map((m) => ({
      id: m.id,
      npc: m.npc,
      owner: null,
      name: m.name,
      tagline: m.id === "maya-chai" ? "Cutting chai since forever" : "Fuses, fixes and relay whispers",
      color: m.id === "maya-chai" ? 0 : 2,
      payout: true,
      products: m.items.map((it) => ({ id: it.id, name: it.name, pricePaise: it.paise, stock: null, desc: "" })),
    }));
  const reservedFor = (shopId, productId) =>
    orders.where((o) => o.shopId === shopId && o.status === "pending_payment").reduce((n, o) => n + (o.items.find((i) => i.productId === productId)?.qty || 0), 0);
  const publicShop = (s) => ({
    id: s.id,
    plot: s.id,
    owner: s.owner,
    ownerName: s.ownerName,
    name: s.name,
    tagline: s.tagline,
    color: s.color,
    payout: !!s.payout, // whether testnet USDT is accepted; the address itself is in the merchant view
    products: s.products.map((p) => ({ ...p, available: p.stock == null ? null : Math.max(0, p.stock - reservedFor(s.id, p.id)) })),
    updatedAt: s.updatedAt,
  });
  function list() {
    const byPlot = new Map(shops.all().map((s) => [s.id, s]));
    return {
      npc: npcShops(),
      plots: PLOTS.map((pl) => ({ plot: pl.id, label: pl.label, shop: byPlot.has(pl.id) ? publicShop(byPlot.get(pl.id)) : null })),
    };
  }
  const changed = (s) => notify.all("shops:update", { plot: s.id, shop: shops.get(s.id) ? publicShop(shops.get(s.id)) : null });

  function own(playerId, shopId) {
    const s = shops.get(shopId);
    if (!s) throw bad("not_found", "No such shop.", 404);
    if (s.owner !== playerId) throw bad("not_owner", "Only the shop's owner can do that.", 403);
    return s;
  }
  const need = (id) => {
    if (!id) throw bad("no_identity", "Join the world first.", 401);
    return id;
  };

  // ---------------------------------------------------------------- shops
  function settings(s, b) {
    if (b.name !== undefined) {
      s.name = clean(b.name, 32);
      if (s.name.length < 2) throw bad("bad_name", "Give your shop a name (2–32 characters).");
    }
    if (b.tagline !== undefined) s.tagline = clean(b.tagline, 60);
    if (b.color !== undefined) s.color = Math.abs(Math.trunc(Number(b.color) || 0)) % SHOP_COLORS.length;
    if (b.payout !== undefined) {
      if (b.payout === null || b.payout === "") s.payout = null;
      else if (!isAddress(String(b.payout)) || /^0x0{40}$/i.test(b.payout)) throw bad("bad_payout", "That isn't a valid wallet address.");
      else s.payout = getAddress(b.payout);
    }
  }

  function claim(playerId, plotId, b = {}, ownerName = "") {
    need(playerId);
    if (!plotById(plotId)) throw bad("not_found", "No such stall.", 404);
    if (shops.get(plotId)) throw bad("taken", "Someone already runs this stall.", 409);
    if (shops.where((s) => s.owner === playerId).length) throw bad("one_shop", "You already run a shop. One stall per courier.", 409);
    const s = { id: plotId, owner: playerId, ownerName: clean(ownerName, 16) || "Courier", name: "", tagline: "", color: 0, payout: null, products: [], createdAt: now(), updatedAt: now() };
    settings(s, { name: b.name ?? `${s.ownerName}'s stall`, tagline: b.tagline ?? "", color: b.color ?? 0, payout: b.payout });
    shops.put(s);
    changed(s);
    return publicShop(s);
  }

  function update(playerId, shopId, b) {
    const s = own(need(playerId), shopId);
    settings(s, b);
    s.updatedAt = now();
    shops.put(s);
    changed(s);
    return { ...publicShop(s), payoutAddress: s.payout };
  }

  function release(playerId, shopId) {
    const s = own(need(playerId), shopId);
    if (orders.where((o) => o.shopId === s.id && o.status === "pending_payment").length) throw bad("pending", "Wait for pending orders to finish first.", 409);
    shops.delete(s.id);
    changed(s);
    return { ok: true };
  }

  function upsertProduct(playerId, shopId, b) {
    const s = own(need(playerId), shopId);
    let p = b.id ? s.products.find((x) => x.id === b.id) : null;
    if (b.id && !p) throw bad("not_found", "No such product.", 404);
    if (b.delete) {
      s.products = s.products.filter((x) => x.id !== b.id);
    } else {
      if (!p) {
        if (s.products.length >= MAX_PRODUCTS) throw bad("too_many", `A stall holds at most ${MAX_PRODUCTS} products.`);
        p = { id: randomUUID().slice(0, 8), name: "", pricePaise: 0, stock: 0, desc: "" };
        s.products.push(p);
      }
      const name = b.name !== undefined ? clean(b.name, 40) : p.name;
      if (name.length < 2) throw bad("bad_name", "Product names need 2–40 characters.");
      p.name = name;
      if (b.price !== undefined) p.pricePaise = price(b.price);
      if (!p.pricePaise) throw bad("bad_price", "Set a price.");
      if (b.stock !== undefined) {
        const st = Math.trunc(Number(b.stock));
        if (!Number.isFinite(st) || st < 0 || st > 9999) throw bad("bad_stock", "Stock must be 0–9999.");
        p.stock = st;
      }
      if (b.desc !== undefined) p.desc = clean(b.desc, 120);
    }
    s.updatedAt = now();
    shops.put(s);
    changed(s);
    return publicShop(s);
  }

  // ---------------------------------------------------------------- orders (B2C)
  /** The on-chain merchant for a shop: registered NPC merchants, or a player shop's direct id. */
  function merchantFor(shopId, token) {
    const npc = merchantById(shopId);
    if (npc) return { id: npc.id, name: npc.name, npc: npc.npc, key: merchantKey(npc.id) };
    const s = shops.get(shopId);
    if (!s) throw bad("not_found", "That shop is closed.", 404);
    if (token === "USDT" && !s.payout) throw bad("no_payout", `${s.name} hasn't set a payout wallet yet, so it only takes DEMO credits.`);
    return { id: s.id, name: s.name, owner: s.owner, key: s.payout ? directMerchantId(s.payout) : null };
  }

  async function order(playerId, buyerName, { shopId, items, token }) {
    need(playerId);
    const npc = merchantById(shopId);
    const s = npc ? null : shops.get(shopId);
    if (!npc && !s) throw bad("not_found", "That shop is closed.", 404);
    if (s?.owner === playerId) throw bad("own_shop", "You can't buy from your own stall.");
    const catalog = npc ? npcShops().find((x) => x.id === shopId).products : s.products;
    if (!Array.isArray(items) || !items.length || items.length > MAX_PRODUCTS) throw bad("empty_cart", "Your basket is empty.");
    const lines = [];
    for (const it of items) {
      const p = catalog.find((x) => x.id === it?.productId);
      const qty = Math.trunc(Number(it?.qty));
      if (!p) throw bad("gone", "Something in your basket is no longer sold here.");
      if (!(qty >= 1 && qty <= MAX_QTY)) throw bad("bad_qty", `Quantities are 1–${MAX_QTY}.`);
      if (p.stock != null && p.stock - reservedFor(shopId, p.id) < qty) throw bad("out_of_stock", `Only ${Math.max(0, p.stock - reservedFor(shopId, p.id))} × ${p.name} left.`, 409);
      lines.push({ productId: p.id, name: p.name, qty, unitPaise: p.pricePaise });
    }
    const total = lines.reduce((n, l) => n + l.qty * l.unitPaise, 0);
    if (total > MAX_INR_PAISE) throw bad("too_much", "Orders are capped at ₹10,000 in this demo economy.");
    return placeOrder({ kind: "b2c", shopId, buyer: playerId, buyerName, lines, total, token });
  }

  async function placeOrder({ kind, shopId, buyer, buyerName, lines, total, token, invoiceId = null }) {
    const merchant = merchantFor(shopId, token);
    const o = {
      id: randomUUID(),
      kind,
      shopId,
      shopName: merchant.name,
      seller: merchant.owner || null,
      buyer,
      buyerName: clean(buyerName, 16) || "Courier",
      items: lines,
      totalPaise: total,
      invoiceId,
      paymentId: null,
      mode: token === "USDT" ? "testnet" : "demo",
      status: "pending_payment",
      fulfillment: "not_started",
      txHash: null,
      createdAt: now(),
      paidAt: null,
    };
    orders.put(o); // reserve stock before any await
    try {
      const note = lines.map((l) => `${l.qty}× ${l.name}`).join(", ").slice(0, 80);
      let p = await payments.createDirect({ merchant: { id: merchant.id, name: merchant.name, npc: merchant.npc, key: merchant.key }, inrPaise: total, note, token, market: { orderId: o.id, kind } });
      o.paymentId = p.id;
      orders.put(o);
      p = await payments.risk(p.id);
      return { order: o, payment: p };
    } catch (e) {
      o.status = "failed";
      orders.put(o);
      throw e;
    }
  }

  /** Called on every payment change: a confirmed on-chain (or DEMO) payment pays its order. */
  function onPayment(p) {
    const o = p.market?.orderId && orders.get(p.market.orderId);
    if (!o || o.status !== "pending_payment") return;
    if (p.state === "COMPLETED") {
      o.status = "paid";
      o.paidAt = now();
      o.txHash = p.txHash || null;
      o.payer = p.payer || null;
      o.relayed = !!p.relayed;
      o.amount = `${p.quote.tokenAmount} ${p.quote.token}`;
      o.inr = p.payout?.label || "DEMO INR SETTLEMENT";
      const s = shops.get(o.shopId);
      if (s) {
        for (const l of o.items) {
          const prod = s.products.find((x) => x.id === l.productId);
          if (prod && prod.stock != null) prod.stock = Math.max(0, prod.stock - l.qty);
        }
        shops.put(s);
        changed(s);
      }
      if (o.invoiceId) {
        const inv = invoices.get(o.invoiceId);
        if (inv) {
          inv.status = "paid";
          inv.paidAt = now();
          inv.txHash = o.txHash;
          invoices.put(inv);
          if (inv.issuer) notify.player(inv.issuer, "invoice:update", inv);
        }
      }
      orders.put(o);
      if (o.seller) notify.player(o.seller, "shop:order", o);
      notify.player(o.buyer, "order:update", o);
    } else if (["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"].includes(p.state)) {
      o.status = p.state === "BLOCKED" ? "blocked" : "cancelled";
      orders.put(o);
      const s = shops.get(o.shopId);
      if (s) changed(s); // releases the reservation
      notify.player(o.buyer, "order:update", o);
    }
  }

  function fulfil(playerId, orderId) {
    const o = orders.get(orderId);
    if (!o) throw bad("not_found", "No such order.", 404);
    own(need(playerId), o.shopId);
    if (!PAID.has(o.status)) throw bad("unpaid", "Only paid orders can be fulfilled.", 409);
    o.status = "fulfilled";
    o.fulfillment = "simulated";
    o.fulfilledAt = now();
    orders.put(o);
    notify.player(o.buyer, "order:update", o);
    return o;
  }

  const sortNew = (a, b) => b.createdAt - a.createdAt;
  const myOrders = (playerId) => orders.where((o) => o.buyer === need(playerId)).sort(sortNew).slice(0, 50);
  function shopOrders(playerId, shopId) {
    own(need(playerId), shopId);
    return orders.where((o) => o.shopId === shopId && o.status !== "pending_payment").sort(sortNew).slice(0, 100);
  }
  const myShop = (playerId) => {
    const s = shops.where((x) => x.owner === playerId)[0];
    return s ? { ...publicShop(s), payoutAddress: s.payout } : null;
  };

  // ---------------------------------------------------------------- invoices (B2B)
  function invoice(playerId, { fromShopId, toShopId, lines, memo }) {
    const from = own(need(playerId), fromShopId);
    const to = shops.get(toShopId);
    if (!to) throw bad("not_found", "Invoices go to another player's shop.", 404);
    if (to.id === from.id) throw bad("self", "You can't invoice your own shop.");
    if (!Array.isArray(lines) || !lines.length || lines.length > 8) throw bad("bad_lines", "An invoice has 1–8 lines.");
    const clean_lines = lines.map((l) => {
      const qty = Math.trunc(Number(l?.qty));
      if (!(qty >= 1 && qty <= 999)) throw bad("bad_qty", "Quantities are 1–999.");
      const name = clean(l?.name, 40);
      if (name.length < 2) throw bad("bad_name", "Each line needs a description.");
      return { name, qty, unitPaise: price(l?.price) };
    });
    const total = clean_lines.reduce((n, l) => n + l.qty * l.unitPaise, 0);
    if (total > MAX_INR_PAISE) throw bad("too_much", "Invoices are capped at ₹10,000 in this demo economy.");
    const inv = { id: randomUUID(), fromShopId: from.id, fromName: from.name, toShopId: to.id, toName: to.name, issuer: playerId, payee: to.owner, lines: clean_lines, totalPaise: total, memo: clean(memo, 120), status: "open", createdAt: now() };
    invoices.put(inv);
    notify.player(to.owner, "invoice:new", inv);
    return inv;
  }

  async function payInvoice(playerId, invoiceId, { token }) {
    const inv = invoices.get(invoiceId);
    if (!inv) throw bad("not_found", "No such invoice.", 404);
    const to = shops.get(inv.toShopId);
    if (!to || to.owner !== need(playerId)) throw bad("not_payee", "Only the invoiced shop's owner can pay it.", 403);
    if (inv.status !== "open") throw bad("not_open", `This invoice is ${inv.status}.`, 409);
    if (orders.where((o) => o.invoiceId === inv.id && o.status === "pending_payment").length) throw bad("in_progress", "A payment for this invoice is already in progress.", 409);
    const lines = inv.lines.map((l, i) => ({ productId: `inv-${i}`, name: l.name, qty: l.qty, unitPaise: l.unitPaise }));
    return placeOrder({ kind: "b2b", shopId: inv.fromShopId, buyer: playerId, buyerName: to.name, lines, total: inv.totalPaise, token, invoiceId: inv.id });
  }

  function cancelInvoice(playerId, invoiceId) {
    const inv = invoices.get(invoiceId);
    if (!inv) throw bad("not_found", "No such invoice.", 404);
    if (inv.issuer !== need(playerId)) throw bad("not_issuer", "Only the issuing shop can cancel it.", 403);
    if (inv.status !== "open") throw bad("not_open", `This invoice is ${inv.status}.`, 409);
    inv.status = "cancelled";
    invoices.put(inv);
    notify.player(inv.payee, "invoice:update", inv);
    return inv;
  }

  const myInvoices = (playerId) => {
    need(playerId);
    return { sent: invoices.where((i) => i.issuer === playerId).sort(sortNew), received: invoices.where((i) => i.payee === playerId).sort(sortNew) };
  };

  /**
   * Abandoned checkouts must not hold stock forever. Looking a payment up expires a stale quote,
   * which cancels its order through onPayment; an order whose payment never got created is dropped.
   */
  function sweep() {
    for (const o of orders.where((x) => x.status === "pending_payment")) {
      if (!o.paymentId) {
        if (now() - o.createdAt > 60_000) (o.status = "cancelled"), orders.put(o);
        continue;
      }
      try {
        onPayment(payments.get(o.paymentId));
      } catch {
        o.status = "cancelled"; // payment record gone
        orders.put(o);
      }
    }
  }

  return { list, claim, update, release, upsertProduct, order, onPayment, fulfil, myOrders, shopOrders, myShop, invoice, payInvoice, cancelInvoice, myInvoices, sweep, _db: { shops, orders, invoices } };
}
