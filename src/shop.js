// Blockhaven market UI: browse stalls, fill a basket, claim a vacant stall, run your shop
// (products, live orders, B2B invoices, settings). Payment hands off to the checkout sheet
// (src/pay), so shop orders get the same quote → safety check → gasless USDT → receipt flow.
import { authed } from "./identity.js";
import { formatInr } from "../shared/upi.js";
import { SHOP_COLORS, plotById } from "../shared/storefronts.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hex = (n) => "#" + n.toString(16).padStart(6, "0");
const ago = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const STATUS = { pending_payment: "awaiting payment", paid: "PAID", fulfilled: "fulfilled (simulated)", cancelled: "cancelled", blocked: "blocked", failed: "failed" };

async function api(path, body) {
  const r = await authed(path, body !== undefined ? { method: "POST", body } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error });
  return j;
}

export function createShops({ net, pay, toast, feed, chime, myName, onOpenChange = () => {}, onShops = () => {} }) {
  let data = { npc: [], plots: [] };
  let mine = null;
  let cfg = null;
  let view = null;
  let cart = new Map(); // productId → qty
  let dashTab = "products";

  const root = document.createElement("div");
  root.id = "shop";
  root.hidden = true;
  root.innerHTML = `<div class="pay-back"></div><section class="pay-sheet" role="dialog" aria-modal="true" aria-labelledby="shop-h"><div class="pay-body"></div></section>`;
  document.body.append(root);
  const body = root.querySelector(".pay-body");
  root.querySelector(".pay-back").onclick = () => close();
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  });
  const isOpen = () => !root.hidden;
  function show() {
    if (root.hidden) {
      root.hidden = false;
      onOpenChange(true);
    }
  }
  function close() {
    if (root.hidden) return;
    if (root.contains(document.activeElement)) document.activeElement.blur();
    root.hidden = true;
    view = null;
    onOpenChange(false);
  }
  function render(html) {
    body.innerHTML = html;
    (body.querySelector("[autofocus]") || body.querySelector("button, input, select"))?.focus({ preventScroll: true });
    body.querySelectorAll("[data-close]").forEach((b) => (b.onclick = close));
  }
  const head = (title, back) => `<header class="pay-head">${back ? `<button class="link" data-back>← ${esc(back)}</button>` : ""}<h2 id="shop-h">${title}</h2><button class="x" data-close aria-label="Close">×</button></header>`;
  const err = (e) => `<p class="err">${esc(e.message || e)}</p>`;

  async function refresh() {
    try {
      [data, { shop: mine }] = await Promise.all([api("/api/shops"), api("/api/shops/mine")]);
      cfg ||= await (await fetch("/api/config")).json();
      onShops(data);
    } catch (e) {
      console.warn("shops:", e.message);
    }
    return data;
  }
  const findShop = (id) => data.npc.find((s) => s.id === id) || data.plots.find((p) => p.shop?.id === id)?.shop || null;

  // ---------------------------------------------------------------- directory
  async function openDirectory() {
    view = "dir";
    show();
    await refresh();
    const player = data.plots.filter((p) => p.shop);
    const vacant = data.plots.filter((p) => !p.shop);
    const card = (s, npc) => `<li><div><b>${esc(s.name)}</b> ${npc ? `<span class="badge demo">NPC</span>` : ""}${s.owner && s.owner === mine?.owner ? ` <span class="badge ok">yours</span>` : ""}
      <small>${npc ? "run by " + esc(s.npc === "maya" ? "Maya" : "Orin") : "run by " + esc(s.ownerName)} · ${s.products.length} item${s.products.length === 1 ? "" : "s"} · ${s.payout ? "USDT or DEMO" : "DEMO only"}</small></div>
      <button class="btn small ${s.owner && s.owner === mine?.owner ? "" : "ghost"}" data-visit="${esc(s.id)}">${s.owner && s.owner === mine?.owner ? "Manage" : "Visit"}</button></li>`;
    render(`${head("Blockhaven market")}
      <p class="fine">Couriers and villagers run these stalls. Pay with gasless Whitechain <b>testnet</b> USDT or DEMO credits. Delivery is simulated; rupees are quoted equivalents only.</p>
      <h3>Village shops</h3><ul class="hist">${data.npc.map((s) => card(s, true)).join("")}</ul>
      <h3>Couriers' stalls</h3><ul class="hist">${player.length ? player.map((p) => card(p.shop, false)).join("") : `<li class="muted">No one has opened a stall yet.</li>`}</ul>
      ${mine ? "" : `<p class="fine">${vacant.length ? `${vacant.length} stall${vacant.length > 1 ? "s are" : " is"} vacant: walk up to a <b>FOR RENT</b> sign to claim one.` : "Every stall is taken right now."}</p>`}`);
    body.querySelectorAll("[data-visit]").forEach((b) => (b.onclick = () => (findShop(b.dataset.visit)?.owner && findShop(b.dataset.visit).owner === mine?.owner ? openDashboard() : openShop(b.dataset.visit))));
  }

  // ---------------------------------------------------------------- a shop: browse + basket
  async function openShop(shopId, msg = "") {
    if (view !== "shop" || openShop.id !== shopId) cart = new Map();
    view = "shop";
    openShop.id = shopId;
    show();
    await refresh();
    const s = findShop(shopId);
    if (!s) return render(`${head("Closed")}<p>This stall has closed.</p>`);
    if (s.owner && s.owner === mine?.owner) return openDashboard();
    const total = [...cart].reduce((n, [pid, q]) => n + (s.products.find((p) => p.id === pid)?.pricePaise || 0) * q, 0);
    const usdtOk = s.payout && cfg?.checkout && cfg?.gasless?.enabled;
    render(`${head(esc(s.name), "Market")}
      <p class="shop-tag" style="--c:${hex(SHOP_COLORS[s.color] ?? 0)}">${esc(s.tagline || "")}<small>${s.npc ? "a village shop" : "run by " + esc(s.ownerName)}</small></p>
      ${msg}
      <ul class="catalog">${
        s.products.length
          ? s.products
              .map((p) => {
                const left = p.available ?? null;
                const q = cart.get(p.id) || 0;
                return `<li><div><b>${esc(p.name)}</b><small>${p.desc ? esc(p.desc) + " · " : ""}${left == null ? "always in stock" : left > 0 ? `${left} left` : "sold out"}</small></div>
                <span class="num">${formatInr(p.pricePaise)}</span>
                <span class="qty"><button type="button" aria-label="One less ${esc(p.name)}" data-dec="${esc(p.id)}" ${q ? "" : "disabled"}>−</button><b aria-live="polite">${q}</b><button type="button" aria-label="One more ${esc(p.name)}" data-inc="${esc(p.id)}" ${left != null && q >= left ? "disabled" : ""}>+</button></span></li>`;
              })
              .join("")
          : `<li class="muted">Nothing on the shelves yet.</li>`
      }</ul>
      <div class="basket"><span>Basket</span><b>${formatInr(total)}</b></div>
      <div class="row-actions">
        <button class="btn" data-pay="USDT" ${total && usdtOk ? "" : "disabled"}>Pay with USDT <small>(no gas)</small></button>
        <button class="btn ghost" data-pay="DEMO" ${total ? "" : "disabled"}>Pay with DEMO credits</button>
      </div>
      ${!usdtOk ? `<p class="fine">${s.payout ? "Testnet USDT checkout isn't configured on this server." : "This stall hasn't set a payout wallet, so it only takes DEMO credits."}</p>` : `<p class="fine">USDT settles on Whitechain Sepolia testnet straight to ${s.npc ? "the shop" : "the owner's wallet"}; the merchant's relayer pays the gas.</p>`}`);
    body.querySelector("[data-back]").onclick = openDirectory;
    body.querySelectorAll("[data-inc]").forEach((b) => (b.onclick = () => (cart.set(b.dataset.inc, (cart.get(b.dataset.inc) || 0) + 1), openShop(shopId))));
    body.querySelectorAll("[data-dec]").forEach((b) => (b.onclick = () => (cart.set(b.dataset.dec, Math.max(0, (cart.get(b.dataset.dec) || 0) - 1)), openShop(shopId))));
    body.querySelectorAll("[data-pay]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            const items = [...cart].filter(([, q]) => q > 0).map(([productId, qty]) => ({ productId, qty }));
            const { payment } = await api("/api/orders", { shopId, items, token: b.dataset.pay, buyerName: myName() });
            cart = new Map();
            close();
            pay.checkoutPayment(payment); // same review → approve → settle → receipt as any payment
          } catch (e) {
            openShop(shopId, err(e));
          }
        }),
    );
  }

  // ---------------------------------------------------------------- claim a vacant stall
  async function openClaim(plotId, msg = "") {
    view = "claim";
    show();
    const pl = plotById(plotId);
    render(`${head("Claim the " + esc(pl.label))}
      <p>Run your own stall: list products, take payments, and see orders arrive live. One stall per courier.</p>
      ${msg}
      <form class="form" id="claim-f">
        <label>Shop name<input name="name" maxlength="32" required autofocus value="${esc(myName())}'s stall"></label>
        <label>Tagline<input name="tagline" maxlength="60" placeholder="What do you sell?"></label>
        <fieldset><legend>Awning</legend><div class="cr-opts">${SHOP_COLORS.map((c, i) => `<label class="sw-pick"><input type="radio" name="color" value="${i}" ${i ? "" : "checked"}><span style="background:${hex(c)}"></span></label>`).join("")}</div></fieldset>
        <label>Payout wallet <small class="muted">(optional; needed to accept testnet USDT)</small><input name="payout" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
        ${pay._wallet.address ? `<button type="button" class="link" data-mywallet>Use my connected wallet ${esc(pay._wallet.address.slice(0, 6))}…</button>` : ""}
        <button class="btn">Open my stall</button>
      </form>`);
    body.querySelector("[data-mywallet]")?.addEventListener("click", () => (body.querySelector("[name=payout]").value = pay._wallet.address));
    body.querySelector("#claim-f").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        await api(`/api/shops/${plotId}/claim`, { ...f, color: Number(f.color), payout: f.payout || null, ownerName: myName() });
        toast(`${f.name} is open for business!`);
        dashTab = "products";
        openDashboard();
      } catch (er) {
        openClaim(plotId, err(er));
      }
    };
  }

  // ---------------------------------------------------------------- owner dashboard
  async function openDashboard(msg = "") {
    view = "dash";
    show();
    await refresh();
    if (!mine) return openDirectory();
    const s = mine;
    const tabs = [["products", "Products"], ["orders", "Orders"], ["invoices", "B2B invoices"], ["settings", "Settings"]];
    let inner = "";
    if (dashTab === "products") {
      inner = `<ul class="catalog own">${s.products.map((p) => `<li><div><b>${esc(p.name)}</b><small>${formatInr(p.pricePaise)} · stock ${p.stock}${p.available !== p.stock ? ` (${p.stock - p.available} reserved)` : ""}</small></div>
          <span class="qty"><button type="button" data-stock="${esc(p.id)}" data-d="-1" aria-label="Less stock">−</button><button type="button" data-stock="${esc(p.id)}" data-d="1" aria-label="More stock">+</button></span>
          <button class="link" data-del="${esc(p.id)}">Remove</button></li>`).join("") || `<li class="muted">No products yet. Add your first below.</li>`}</ul>
        <form class="form inline" id="prod-f"><input name="name" placeholder="Product" maxlength="40" required><input name="price" placeholder="₹ price" inputmode="decimal" required><input name="stock" placeholder="Stock" inputmode="numeric" value="10" required><button class="btn small">Add</button></form>`;
    } else if (dashTab === "orders") {
      const { orders } = await api(`/api/shops/${s.id}/orders`);
      inner = `<ul class="hist">${orders.map((o) => `<li><div><b>${esc(o.items.map((i) => `${i.qty}× ${i.name}`).join(", "))}</b> ${o.kind === "b2b" ? `<span class="badge demo">B2B</span>` : ""} ${o.mode === "testnet" ? `<span class="badge real">TESTNET CRYPTO</span>` : `<span class="badge demo">DEMO</span>`}
          <small>${ago(o.createdAt)} · from ${esc(o.buyerName)} · ${formatInr(o.totalPaise)} · ${esc(STATUS[o.status] || o.status)}${o.amount ? ` · ${esc(o.amount)}` : ""}${o.txHash ? ` · <a href="https://explorer.testnet.whitechain.io/tx/${esc(o.txHash)}" target="_blank" rel="noopener">tx ↗</a>` : ""}</small></div>
          ${o.status === "paid" ? `<button class="btn small" data-fulfil="${esc(o.id)}">Mark delivered</button>` : ""}</li>`).join("") || `<li class="muted">No orders yet. They appear here the moment a payment confirms.</li>`}</ul>
        <p class="fine">Delivery is simulated. Rupee amounts are quoted equivalents (DEMO INR SETTLEMENT).</p>`;
    } else if (dashTab === "invoices") {
      const inv = await api("/api/invoices/mine");
      const others = data.plots.filter((p) => p.shop && p.shop.id !== s.id).map((p) => p.shop);
      const row = (i, sent) => `<li><div><b>${sent ? "To " + esc(i.toName) : "From " + esc(i.fromName)}</b> <span class="badge demo">B2B</span><small>${esc(i.lines.map((l) => `${l.qty}× ${l.name}`).join(", "))} · ${formatInr(i.totalPaise)} · ${esc(i.status)}${i.memo ? " · “" + esc(i.memo) + "”" : ""}</small></div>
          ${!sent && i.status === "open" ? `<span><button class="btn small" data-payinv="${esc(i.id)}" data-tok="USDT" ${mine.payout !== undefined && cfg?.gasless?.enabled ? "" : "disabled"}>Pay USDT</button> <button class="btn small ghost" data-payinv="${esc(i.id)}" data-tok="DEMO">Pay DEMO</button></span>` : sent && i.status === "open" ? `<button class="link" data-cancelinv="${esc(i.id)}">Cancel</button>` : ""}</li>`;
      inner = `<h3>Received</h3><ul class="hist">${inv.received.map((i) => row(i, false)).join("") || `<li class="muted">None.</li>`}</ul>
        <h3>Sent</h3><ul class="hist">${inv.sent.map((i) => row(i, true)).join("") || `<li class="muted">None.</li>`}</ul>
        ${others.length ? `<h3>New invoice</h3><form class="form" id="inv-f"><label>To<select name="to">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)} (${esc(o.ownerName)})</option>`).join("")}</select></label>
          <div class="form inline"><input name="name" placeholder="Description" maxlength="40" required><input name="qty" placeholder="Qty" inputmode="numeric" value="1" required><input name="price" placeholder="₹ each" inputmode="decimal" required></div>
          <label>Memo<input name="memo" maxlength="120" placeholder="Optional"></label><button class="btn small">Send invoice</button></form>` : `<p class="fine">Invoices go to other couriers' stalls; none are open yet.</p>`}`;
    } else {
      inner = `<form class="form" id="set-f">
        <label>Shop name<input name="name" maxlength="32" value="${esc(s.name)}" required></label>
        <label>Tagline<input name="tagline" maxlength="60" value="${esc(s.tagline)}"></label>
        <fieldset><legend>Awning</legend><div class="cr-opts">${SHOP_COLORS.map((c, i) => `<label class="sw-pick"><input type="radio" name="color" value="${i}" ${i === s.color ? "checked" : ""}><span style="background:${hex(c)}"></span></label>`).join("")}</div></fieldset>
        <label>Payout wallet <small class="muted">(receives testnet USDT directly)</small><input name="payout" value="${esc(s.payoutAddress || "")}" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
        ${pay._wallet.address ? `<button type="button" class="link" data-mywallet>Use my connected wallet</button>` : ""}
        <button class="btn small">Save</button></form>
        <p><button class="link" data-release>Close this stall</button></p>`;
    }
    render(`${head(esc(s.name), "Market")}
      <div class="cr-tabs" role="tablist">${tabs.map(([k, n]) => `<button type="button" role="tab" data-dtab="${k}" aria-selected="${k === dashTab}">${n}</button>`).join("")}</div>
      ${msg}${inner}`);
    body.querySelector("[data-back]").onclick = openDirectory;
    body.querySelectorAll("[data-dtab]").forEach((b) => (b.onclick = () => ((dashTab = b.dataset.dtab), openDashboard())));
    const act = (fn) => async (e) => {
      e.preventDefault?.();
      try {
        await fn(e);
        openDashboard();
      } catch (er) {
        openDashboard(err(er));
      }
    };
    body.querySelector("#prod-f")?.addEventListener("submit", act((e) => api(`/api/shops/${s.id}/products`, Object.fromEntries(new FormData(e.target)))));
    body.querySelectorAll("[data-stock]").forEach((b) => (b.onclick = act(() => api(`/api/shops/${s.id}/products`, { id: b.dataset.stock, stock: Math.max(0, s.products.find((p) => p.id === b.dataset.stock).stock + Number(b.dataset.d)) }))));
    body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = act(() => api(`/api/shops/${s.id}/products`, { id: b.dataset.del, delete: true }))));
    body.querySelectorAll("[data-fulfil]").forEach((b) => (b.onclick = act(() => api(`/api/orders/${b.dataset.fulfil}/fulfil`, {}))));
    body.querySelectorAll("[data-cancelinv]").forEach((b) => (b.onclick = act(() => api(`/api/invoices/${b.dataset.cancelinv}/cancel`, {}))));
    body.querySelectorAll("[data-payinv]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            const { payment } = await api(`/api/invoices/${b.dataset.payinv}/pay`, { token: b.dataset.tok });
            close();
            pay.checkoutPayment(payment);
          } catch (er) {
            openDashboard(err(er));
          }
        }),
    );
    body.querySelector("#inv-f")?.addEventListener(
      "submit",
      act((e) => {
        const f = Object.fromEntries(new FormData(e.target));
        return api("/api/invoices", { fromShopId: s.id, toShopId: f.to, lines: [{ name: f.name, qty: Number(f.qty), price: f.price }], memo: f.memo });
      }),
    );
    body.querySelector("[data-mywallet]")?.addEventListener("click", () => (body.querySelector("[name=payout]").value = pay._wallet.address));
    body.querySelector("#set-f")?.addEventListener(
      "submit",
      act((e) => {
        const f = Object.fromEntries(new FormData(e.target));
        return api(`/api/shops/${s.id}`, { ...f, color: Number(f.color), payout: f.payout || null });
      }),
    );
    body.querySelector("[data-release]")?.addEventListener("click", async () => {
      if (!confirm(`Close ${s.name}? Your products are removed; past orders stay in history.`)) return;
      try {
        await api(`/api/shops/${s.id}/release`, {});
        close();
        toast("Your stall is closed.");
      } catch (er) {
        openDashboard(err(er));
      }
    });
  }

  /** Walking up to a stall: claim it, manage it, or browse it. */
  async function openPlot(plotId) {
    await refresh();
    const p = data.plots.find((x) => x.plot === plotId);
    if (!p?.shop) return mine ? (show(), render(`${head("FOR RENT")}<p>You already run <b>${esc(mine.name)}</b>. One stall per courier.</p>`)) : openClaim(plotId);
    if (p.shop.owner === mine?.owner) return openDashboard();
    return openShop(p.shop.id);
  }

  // ---------------------------------------------------------------- live events
  net.on("shops:update", () => refresh().then(() => isOpen() && (view === "shop" ? openShop(openShop.id) : view === "dir" ? openDirectory() : null)));
  net.on("shop:order", (o) => {
    chime?.();
    const what = o.items.map((i) => `${i.qty}× ${i.name}`).join(", ");
    toast(`New order PAID: ${what} from ${o.buyerName} (${o.mode === "testnet" ? "TESTNET CRYPTO" : "DEMO"})`, 6000);
    feed?.(`Your stall sold ${what}`);
    if (isOpen() && view === "dash") openDashboard();
  });
  net.on("order:update", (o) => o.status === "fulfilled" && toast(`${o.shopName} marked your order delivered (simulated).`));
  net.on("invoice:new", (i) => {
    chime?.();
    toast(`Invoice from ${i.fromName}: ${formatInr(i.totalPaise)}. Open your stall's B2B tab to pay.`, 6000);
  });
  net.on("invoice:update", (i) => i.status === "paid" && toast(`${i.toName} paid your invoice (${formatInr(i.totalPaise)}).`, 5000));

  return { refresh, openDirectory, openShop, openPlot, openDashboard, isOpen, close, get data() {
      return data;
    }, get mine() {
      return mine;
    } };
}
