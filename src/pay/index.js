// OMEN's wallet + scan-and-pay UI. The game talks to it through initPay(); it reports the payment
// journey back through `onStage` so the village can react.
import "./pay.css";
import { wallet } from "./wallet.js";
import { demo, DEMO_ASSETS } from "./demo.js";
import { qrCanvas, decodeCanvas, decodeFile, scanCamera } from "./qr.js";
import { parseUpiQr, formatInr } from "../../shared/upi.js";
import { MERCHANTS, merchantById, merchantByVpa, merchantQr } from "../../shared/merchants.js";
import { formatUnits } from "../../shared/money.js";
import { txUrl, arkivTxUrl, USDT, WHITECHAIN, ARKIV } from "../../shared/chains.js";
import { paymentRecord } from "../../shared/arkivRecord.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const arkiv = () => import("./arkiv.js"); // the Arkiv SDK loads only when it's needed
const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage blocked */
    }
  },
};

async function api(path, body) {
  let r;
  try {
    r = await fetch("/api" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  } catch {
    throw new Error("The OMEN payment gateway isn't reachable. Start it with `npm run dev`.");
  }
  const j = await r.json().catch(() => ({ message: `Gateway error (HTTP ${r.status}).` }));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error });
  return j;
}

const Badge = {
  testnet: `<span class="badge real" title="A real transaction on Whitechain Sepolia testnet. Test tokens have no monetary value.">TESTNET CRYPTO</span>`,
  demo: `<span class="badge demo" title="Play money stored in this browser only. Nothing touches a blockchain.">DEMO</span>`,
  sim: `<span class="badge sim" title="No authorized INR payout provider is integrated: rupees are a quoted equivalent only.">DEMO INR SETTLEMENT</span>`,
  arkiv: `<span class="badge arkiv" title="Read back from Arkiv (Rabdi testnet)">ON ARKIV</span>`,
};
const STEPS = [
  ["scan", "Scan"],
  ["review", "Review"],
  ["approve", "Approve"],
  ["settle", "Settle"],
  ["receipt", "Receipt"],
];

export function initPay({ onStage = () => {}, onOpenChange = () => {} } = {}) {
  let cfg = null;
  let view = null;
  let co = null; // current checkout
  let camera = null;
  let timer = 0;
  const payments = store.get("omen.payments.v1", []);
  const deliveries = store.get("omen.deliveries.v1", []);
  let arkivRows = null;
  let arkivAutoFor = null; // wallet whose Arkiv history we auto-loaded
  let arkivErr = "";

  // ------------------------------------------------------------------ shell
  const root = document.createElement("div");
  root.id = "pay";
  root.hidden = true;
  root.innerHTML = `<div class="pay-back"></div><section class="pay-sheet" role="dialog" aria-modal="true" aria-labelledby="pay-h"><div class="pay-body"></div></section>`;
  document.body.append(root);
  const body = root.querySelector(".pay-body");
  root.querySelector(".pay-back").onclick = () => close();
  root.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep WASD/E/Tab away from the game while the sheet is open
    if (e.key === "Escape") close();
  });
  // keyup is NOT stopped: the game must always hear a key being released, or it stays held.

  const hudBtn = document.createElement("button");
  hudBtn.id = "wallet-btn";
  hudBtn.type = "button";
  hudBtn.setAttribute("aria-label", "Open wallet (P)");
  hudBtn.innerHTML = `<svg viewBox="0 0 48 40" aria-hidden="true"><rect x="4" y="8" width="38" height="27" rx="5" fill="#3E8E8A" stroke="#2B2230" stroke-width="2.6"/><path d="M8 8l22-6 4 6" fill="#F3D98B" stroke="#2B2230" stroke-width="2.4" stroke-linejoin="round"/><rect x="28" y="16" width="16" height="11" rx="3" fill="#FBF3E4" stroke="#2B2230" stroke-width="2.4"/><circle cx="34" cy="21.5" r="2.2" fill="#2B2230"/></svg><span>Wallet</span>`;
  hudBtn.onclick = () => openWallet();
  document.getElementById("hud")?.append(hudBtn);

  const isOpen = () => !root.hidden;
  function show() {
    if (root.hidden) {
      root.hidden = false;
      onOpenChange(true);
    }
  }
  function close() {
    if (root.hidden) return;
    camera?.stop();
    camera = null;
    clearInterval(timer);
    if (co && !["receipt"].includes(co.step) && co.payment && !["COMPLETED", "FAILED", "BLOCKED", "EXPIRED", "CANCELLED"].includes(co.payment.state) && co.payment.state !== "SUBMITTED")
      api(`/payments/${co.payment.id}/cancel`, {}).catch(() => {});
    if (co) onStage("close", co);
    co = null;
    // Hand the keyboard back to the game: a focused element left inside the hidden sheet would
    // keep swallowing WASD/E/P through the sheet's key handler.
    if (root.contains(document.activeElement)) document.activeElement.blur();
    root.hidden = true;
    onOpenChange(false);
  }
  function render(html, focus = true) {
    body.innerHTML = html;
    if (focus) (body.querySelector("[autofocus]") || body.querySelector("button, input, select"))?.focus({ preventScroll: true });
  }
  const loadCfg = async () => (cfg ||= await api("/config").catch((e) => ({ error: e.message })));
  let lastWallet = null;
  wallet.onChange(() => {
    if (wallet.address !== lastWallet) {
      lastWallet = wallet.address;
      arkivRows = null; // another wallet: its own records, not the previous one's
      arkivAutoFor = null;
    }
    if (isOpen() && view === "wallet") renderWallet();
  });

  // ------------------------------------------------------------------ wallet panel
  async function openWallet() {
    view = "wallet";
    show();
    renderWallet();
    await loadCfg();
    if (view === "wallet") renderWallet();
    refreshBalances();
  }
  let bal = null;
  let balErr = "";
  async function refreshBalances() {
    if (!wallet.address) return;
    try {
      bal = await wallet.balances();
      balErr = "";
    } catch (e) {
      balErr = "Couldn't read Whitechain balances: " + (e.shortMessage || e.message);
    }
    if (view === "wallet" && isOpen()) renderWallet();
  }

  function renderWallet() {
    const d = demo.balances();
    const conn = wallet.address
      ? `<div class="acct"><span class="dot ${wallet.chainId === WHITECHAIN.id ? "ok" : ""}"></span><b>${esc(wallet.name)}</b> <code>${short(wallet.address)}</code>
         <span class="muted">${wallet.chainId === WHITECHAIN.id ? "on Whitechain Sepolia" : `chain ${wallet.chainId}`}</span>
         <button class="link" data-act="disconnect">Disconnect</button></div>`
      : `<div class="acct"><button class="btn small" data-act="connect" autofocus>Connect EVM wallet</button><span class="muted">${wallet.available() ? "MetaMask, Rabby or any injected wallet" : "No browser wallet detected. DEMO credits still work."}</span></div>`;
    const rows = [
      ["USDT", "Tether USD · Whitechain Sepolia", bal ? formatUnits(bal.USDT, 6) : wallet.address ? "…" : "—", Badge.testnet, "Spend at village merchants"],
      ["WBT", "Whitechain gas token", bal ? formatUnits(bal.WBT, 18, 4) : wallet.address ? "…" : "—", Badge.testnet, "Pays network fees"],
      ["DEMO", "DEMO credits (1 credit = ₹1)", formatUnits(d.DEMO, 2), Badge.demo, "Play money, this browser only"],
      ["dUSDT", "Demo USDT", formatUnits(d.dUSDT ?? 0n, 6), Badge.demo, "Swap target"],
      ["dWBT", "Demo WBT", formatUnits(d.dWBT ?? 0n, 18, 4), Badge.demo, "Swap target"],
    ];
    render(`
      <header class="pay-head"><h2 id="pay-h">Wallet</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
      ${conn}
      ${balErr ? `<p class="err">${esc(balErr)}</p>` : ""}
      ${cfg?.error ? `<p class="err">${esc(cfg.error)}</p>` : ""}
      <table class="tokens"><tbody>${rows.map(([s, n, v, b, h]) => `<tr><td><b>${s}</b><small>${n}</small></td><td class="num">${v}</td><td>${b}<small>${h}</small></td></tr>`).join("")}</tbody></table>
      <p class="fine">Need test funds? <a href="${WHITECHAIN.faucet}" target="_blank" rel="noopener">Whitechain faucet</a> for WBT · test USDT from the Whitechain team · <a href="${ARKIV.faucet}" target="_blank" rel="noopener">Arkiv faucet</a> for record gas.
      ${cfg && !cfg.error ? (cfg.checkout ? `Checkout contract <a href="${WHITECHAIN.explorer}/address/${cfg.checkout}" target="_blank" rel="noopener"><code>${short(cfg.checkout)}</code></a>.` : `<b>Checkout contract not configured on this server: USDT payments are off, DEMO works.</b>`) : ""}</p>
      <div class="row-actions">
        <button class="btn small" data-act="scan">Scan a QR</button>
        <button class="btn small ghost" data-act="send">Send</button>
        <button class="btn small ghost" data-act="swap">Swap</button>
        <button class="btn small ghost" data-act="history">History</button>
        <button class="btn small ghost" data-act="tutorial">How it works</button>
      </div>`);
    bindActs({
      connect: async (b) => {
        b.disabled = true;
        try {
          await wallet.connect();
          refreshBalances();
        } catch (e) {
          balErr = e.shortMessage || e.message;
          renderWallet();
        }
      },
      disconnect: () => {
        wallet.disconnect();
        bal = null;
        renderWallet();
      },
      scan: () => startCheckout({ source: "camera" }),
      send: () => renderSend(),
      swap: () => renderSwap(),
      history: () => renderHistory(),
      tutorial: () => renderTutorial(() => renderWallet()),
    });
  }

  function bindActs(map) {
    body.querySelectorAll("[data-act]").forEach((b) => {
      const fn = b.dataset.act === "close" ? close : b.dataset.act === "wallet" ? openWallet : map[b.dataset.act];
      if (fn) b.onclick = (e) => (e.preventDefault(), fn(b, e));
    });
  }

  // ------------------------------------------------------------------ send + swap
  function renderSend(msg = "") {
    view = "send";
    render(`
      <header class="pay-head"><button class="link" data-act="wallet">← Wallet</button><h2 id="pay-h">Send</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
      <form class="form" id="send-f">
        <label>Asset<select name="asset">
          <option value="USDT">USDT · Whitechain testnet (real)</option><option value="WBT">WBT · Whitechain testnet (real)</option>
          <option value="DEMO">DEMO credits</option><option value="dUSDT">Demo USDT</option><option value="dWBT">Demo WBT</option></select></label>
        <label>To<input name="to" autocomplete="off" spellcheck="false" placeholder="0x…" required></label>
        <label>Amount<input name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" required></label>
        <p class="fine">Real testnet transfers are signed in your wallet and can't be undone. DEMO transfers only change this browser's play balance.</p>
        ${msg}
        <button class="btn" type="submit">Review &amp; send</button>
      </form>`);
    bindActs({});
    body.querySelector("#send-f").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        if (f.asset === "USDT" || f.asset === "WBT") {
          if (!wallet.address) throw new Error("Connect a wallet first.");
          if (!confirm(`Send ${f.amount} ${f.asset} on Whitechain Sepolia to ${f.to}? Your wallet will ask you to approve.`)) return (btn.disabled = false);
          const hash = await wallet.transfer(f.asset, f.to.trim(), f.amount.trim());
          payments.unshift({ id: hash, kind: "transfer", mode: "testnet", createdAt: Date.now(), state: "COMPLETED", txHash: hash, quote: { token: f.asset, tokenAmount: f.amount }, to: f.to });
          store.set("omen.payments.v1", payments.slice(0, 60));
          renderSend(`<p class="ok">Sent ${Badge.testnet} <a href="${txUrl(hash)}" target="_blank" rel="noopener">view on explorer</a></p>`);
          refreshBalances();
        } else {
          demo.transfer(f.asset, f.to.trim(), f.amount.trim());
          renderSend(`<p class="ok">${Badge.demo} Sent ${esc(f.amount)} ${esc(f.asset)} to ${esc(f.to)} (play money, no blockchain).</p>`);
        }
      } catch (err) {
        renderSend(`<p class="err">${esc(err.shortMessage || err.message)}</p>`);
      }
    };
  }

  function renderSwap(msg = "") {
    view = "swap";
    const opts = Object.entries(DEMO_ASSETS).map(([k, a]) => `<option value="${k}">${esc(a.label)}</option>`).join("");
    render(`
      <header class="pay-head"><button class="link" data-act="wallet">← Wallet</button><h2 id="pay-h">Swap ${Badge.demo}</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
      <form class="form" id="swap-f">
        <div class="two"><label>From<select name="from">${opts}</select></label><label>To<select name="to">${opts.replace('value="dUSDT"', 'value="dUSDT" selected')}</select></label></div>
        <label>Amount<input name="amount" inputmode="decimal" autocomplete="off" value="880" required></label>
        <p class="fine">Demo swaps use fixed play rates (1 dUSDT = 88 DEMO, 1 dWBT = 2,400 DEMO). Real testnet swaps aren't integrated in OMEN; nothing here touches a DEX.</p>
        ${msg}
        <button class="btn" type="submit">Swap</button>
      </form>`);
    bindActs({});
    body.querySelector("#swap-f").onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        const out = demo.swap(f.from, f.to, f.amount.trim());
        renderSwap(`<p class="ok">${Badge.demo} Got ${formatUnits(out, DEMO_ASSETS[f.to].decimals, 6)} ${esc(f.to)}.</p>`);
      } catch (err) {
        renderSwap(`<p class="err">${esc(err.message)}</p>`);
      }
    };
  }

  // ------------------------------------------------------------------ history + receipts
  function renderHistory() {
    view = "history";
    const local = payments.map((p) => ({ ...p, src: "local" }));
    const demos = demo
      .log()
      .filter((l) => l.kind !== "payment")
      .map((l) => ({ id: `d${l.at}`, kind: l.kind, mode: "demo", createdAt: l.at, state: "COMPLETED", quote: { token: l.asset, tokenAmount: formatUnits(-BigInt(l.units), DEMO_ASSETS[l.asset].decimals) }, to: l.to, src: "demo" }));
    const all = [...local, ...demos].sort((a, b) => b.createdAt - a.createdAt);
    const ark = arkivRows
      ? arkivRows.length
        ? arkivRows.map((r) => `<li><div><b>${esc(r.kind === "delivery" ? `Delivery → ${r.merchant}` : merchantById(r.merchant)?.name || r.merchant)}</b> ${Badge.arkiv} ${r.mode === "testnet" ? Badge.testnet : r.mode === "demo" ? Badge.demo : ""}
            <small>${new Date(Number(r.createdAt)).toLocaleString()} · ${esc(r.status)} ${r.inrPaise ? "· " + formatInr(Number(r.inrPaise)) : ""} ${r.amount ? `· ${esc(r.amount)} ${esc(r.token)}` : ""}</small>
            <small><a href="${ARKIV.explorer}/entity/${esc(r.$key)}" target="_blank" rel="noopener">entity ${short(r.$key)}</a>${r.whitechainTx ? ` · <a href="${txUrl(r.whitechainTx)}" target="_blank" rel="noopener">Whitechain tx</a>` : ""}${r.zgRequestId ? ` · 0G ${esc(r.zgRequestId.slice(0, 18))}` : ""}</small></div></li>`).join("")
        : `<li class="muted">No OMEN records owned by this wallet on Arkiv yet.</li>`
      : "";
    const pend = deliveries.filter((d) => !d.arkiv);
    render(`
      <header class="pay-head"><button class="link" data-act="wallet">← Wallet</button><h2 id="pay-h">History</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
      <ul class="hist">${all.length ? all.map((p) => histItem(p)).join("") : `<li class="muted">No payments yet. Scan Maya's QR at the chai stall.</li>`}</ul>
      <h3>Arkiv records <small class="muted">payment &amp; delivery records owned by your wallet</small></h3>
      ${arkivErr ? `<p class="err">${esc(arkivErr)}</p>` : ""}
      <ul class="hist">${ark}</ul>
      <div class="row-actions">
        <button class="btn small" data-act="arkivLoad" ${wallet.address ? "" : "disabled"}>${arkivRows ? "Refresh from Arkiv" : "Load from Arkiv"}</button>
        ${pend.length ? `<button class="btn small ghost" data-act="arkivDeliveries" ${wallet.address ? "" : "disabled"}>Write ${pend.length} courier deliver${pend.length > 1 ? "ies" : "y"} to Arkiv</button>` : ""}
        ${wallet.address ? "" : `<span class="muted">Connect a wallet to use Arkiv.</span>`}
      </div>`);
    body.querySelectorAll("[data-receipt]").forEach((b) => (b.onclick = () => renderReceipt(payments.find((p) => p.id === b.dataset.receipt), "history")));
    bindActs({
      arkivLoad: async (b) => {
        b.disabled = true;
        b.textContent = "Querying Arkiv…";
        try {
          arkivRows = await (await arkiv()).queryRecords(wallet.address);
          arkivErr = "";
        } catch (e) {
          arkivErr = "Arkiv query failed: " + (e.shortMessage || e.message);
        }
        renderHistory();
      },
      arkivDeliveries: async (b) => {
        b.disabled = true;
        try {
          const { writeRecord } = await arkiv();
          for (const d of pend) {
            b.textContent = `Writing ${d.id}… (approve in wallet)`;
            const r = await writeRecord({ kind: "delivery", mode: "story", merchant: d.to, status: "delivered", ref: d.id, createdAt: d.at, note: d.note });
            d.arkiv = { entityKey: r.entityKey, txHash: r.txHash };
            store.set("omen.deliveries.v1", deliveries);
          }
          arkivRows = await (await arkiv()).queryRecords(wallet.address);
        } catch (e) {
          arkivErr = "Arkiv write failed: " + (e.shortMessage || e.message);
        }
        renderHistory();
      },
    });
    // After a refresh, the wallet-owned records come straight back from Arkiv.
    if (wallet.address && arkivRows === null && arkivAutoFor !== wallet.address) {
      arkivAutoFor = wallet.address;
      body.querySelector("[data-act=arkivLoad]")?.click();
    }
  }

  function histItem(p) {
    const title = p.kind === "transfer" ? `Transfer → ${short(p.to) || p.to}` : p.kind === "swap" ? `Swap → ${p.to}` : p.merchant?.name || p.upi?.vpa || "Payment";
    const amt = p.quote ? `${esc(p.quote.tokenAmount)} ${esc(p.quote.token)}` : "";
    const inr = p.quote?.inrPaise ? ` · ${formatInr(p.quote.inrPaise)}` : "";
    const btn = p.upi ? `<button class="link" data-receipt="${esc(p.id)}">Receipt</button>` : p.txHash ? `<a href="${txUrl(p.txHash)}" target="_blank" rel="noopener">tx</a>` : "";
    return `<li><div><b>${esc(title)}</b> ${p.mode === "testnet" ? Badge.testnet : Badge.demo} ${p.arkiv ? Badge.arkiv : ""}<small>${new Date(p.createdAt).toLocaleString()} · ${esc(p.state)} · ${amt}${inr}</small></div>${btn}</li>`;
  }

  function remember(p) {
    const i = payments.findIndex((x) => x.id === p.id);
    if (i >= 0) payments[i] = { ...payments[i], ...p };
    else payments.unshift(p);
    store.set("omen.payments.v1", payments.slice(0, 60));
  }

  function renderReceipt(p, back = "wallet") {
    view = "receipt";
    if (!p) return renderHistory();
    const done = p.state === "COMPLETED";
    const ai = p.risk?.ai;
    render(`
      <header class="pay-head">${back === "history" ? `<button class="link" data-act="back">← History</button>` : ""}<h2 id="pay-h">${done ? "Paid" : esc(p.state)}</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
      ${co ? steps("receipt", !done) : ""}
      <div class="receipt ${done ? "paid" : "bad"}">
        <p class="big">${formatInr(p.quote.inrPaise)} <span>to ${esc(p.merchant?.name || p.upi.name || p.upi.vpa)}</span></p>
        <dl>
          <dt>You paid</dt><dd>${esc(p.quote.tokenAmount)} ${esc(p.quote.token)} <small>(rate ₹${esc(p.quote.rate)}, fee ${formatInr(p.quote.feePaise)})</small></dd>
          ${p.mode === "testnet" ? `<dt>Gas</dt><dd>${p.relayed ? "₹0 for you: paid by the merchant's relayer (you only signed)" : "paid in WBT by your wallet"}</dd>` : ""}
          ${p.balance ? `<dt>Your USDT</dt><dd>${p.balance.before != null ? `${esc(p.balance.before)} → ` : ""}<b>${esc(p.balance.after)}</b> <small>read from Whitechain after settlement</small></dd>` : ""}
          ${p.txHash ? `<dt>Whitechain tx</dt><dd><a href="${txUrl(p.txHash)}" target="_blank" rel="noopener"><code>${short(p.txHash)}</code> ↗</a>${p.onchain ? ` <small>block ${esc(p.onchain.blockNumber)}, verified by the gateway</small>` : ""}</dd>` : ""}
          ${p.mode === "demo" ? `<dt>Settlement</dt><dd>DEMO credits, no blockchain transaction</dd>` : ""}
          <dt>Mode</dt><dd>${p.mode === "testnet" ? "<b>TESTNET CRYPTO PAYMENT</b>" : "<b>DEMO</b> (play credits)"}</dd>
          <dt>INR</dt><dd>${p.payout ? (p.payout.real && p.payout.providerRef ? `Settled by provider, ref <code>${esc(p.payout.providerRef)}</code>` : `${Badge.sim} <small>${formatInr(p.payout.inrPaise)} is the quoted equivalent; no rupees moved and there is no bank reference</small>`) : "—"}</dd>
          <dt>Risk check</dt><dd>${riskSummary(p.risk)}</dd>
          ${ai?.requestId ? `<dt>0G request</dt><dd><code class="wrap">${esc(ai.requestId)}</code> <small>${esc(ai.provider || "")} ${esc(ai.model || "")}${ai.verified === true ? " · response verified" : ai.verified === false ? " · verification failed" : ""}</small></dd>` : ""}
          <dt>Order</dt><dd><code class="wrap">${esc(p.id)}</code></dd>
          ${p.arkiv ? `<dt>Arkiv record</dt><dd>${Badge.arkiv} <a href="${arkivTxUrl(p.arkiv.txHash)}" target="_blank" rel="noopener">tx ${short(p.arkiv.txHash)}</a> <small>entity ${short(p.arkiv.entityKey)}</small></dd>` : ""}
        </dl>
        ${p.history ? `<details><summary>State machine trail</summary><ol class="trail">${p.history.map((h) => `<li><code>${esc(h.to)}</code> <small>${new Date(h.at).toLocaleTimeString()}${h.reason ? " · " + esc(h.reason) : ""}</small></li>`).join("")}</ol></details>` : ""}
      </div>
      <p class="err" id="rc-err" hidden></p>
      <div class="row-actions">
        ${done && !p.arkiv ? `<button class="btn small" data-act="arkivSave" ${wallet.address ? "" : "disabled title='Connect a wallet first'"}>Save receipt to Arkiv</button>` : ""}
        <button class="btn small ${done && !p.arkiv ? "ghost" : ""}" data-act="${back === "history" ? "back" : "close"}" autofocus>${back === "history" ? "Back" : "Done"}</button>
      </div>`);
    bindActs({
      back: () => renderHistory(),
      arkivSave: async (b) => {
        b.disabled = true;
        b.textContent = "Approve in wallet (Arkiv)…";
        try {
          const r = await (await arkiv()).writeRecord(paymentRecord(p));
          p.arkiv = { entityKey: r.entityKey, txHash: r.txHash };
          remember(p);
          onStage("arkiv", { payment: p });
          renderReceipt(p, back);
        } catch (e) {
          const el = body.querySelector("#rc-err");
          el.hidden = false;
          el.textContent = "Arkiv write failed: " + (e.shortMessage || e.message);
          b.disabled = false;
          b.textContent = "Save receipt to Arkiv";
        }
      },
    });
  }

  function riskSummary(r) {
    if (!r) return "—";
    const ai = r.ai;
    const aiText =
      ai.status === "ok"
        ? `0G AI: <b>${esc(ai.risk)}</b>${ai.reasons?.length ? ` <small>(${ai.reasons.map(esc).join("; ")})</small>` : ""}`
        : `<small>${esc(ai.note || "No AI verdict.")}</small>`;
    return `<span class="lvl ${r.level}">${esc(r.level)}</span> ${aiText}`;
  }

  // ------------------------------------------------------------------ checkout
  const steps = (cur, failed = false) => {
    const i = STEPS.findIndex(([k]) => k === cur);
    return `<ol class="journey">${STEPS.map(([k, n], j) => `<li class="${j < i ? "done" : j === i ? (failed ? "fail" : "now") : ""}">${n}</li>`).join("")}</ol>`;
  };

  /**
   * Begin a checkout. From the village: { merchantId, sign: <canvas> } (the sign's pixels are
   * decoded). From the wallet: { source: "camera" } for a real-world QR.
   */
  async function startCheckout(opts = {}) {
    view = "checkout";
    co = { step: "scan", merchant: opts.merchantId ? merchantById(opts.merchantId) : null, sign: opts.sign || null };
    show();
    onStage("scan", co);
    await loadCfg();
    if (!store.get("omen.tutorial.seen", false)) return renderTutorial(() => scanStep());
    scanStep();
  }

  function scanStep(err = "") {
    co.step = "scan";
    if (co.sign) {
      const text = decodeCanvas(co.sign);
      if (!text) return scanManual("Couldn't read the sign. Try again or paste the code.");
      return parsed(text);
    }
    scanManual(err);
  }

  function scanManual(err = "") {
    render(`
      <header class="pay-head"><button class="link" data-act="wallet">← Wallet</button><h2 id="pay-h">Scan a UPI QR</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
      ${steps("scan", !!err)}
      ${err ? `<p class="err">${esc(err)}</p>` : ""}
      <div class="cam"><video playsinline muted></video><p class="muted">Point your camera at a UPI QR…</p></div>
      <div class="row-actions">
        <button class="btn small" data-act="cam">Use camera</button>
        <label class="btn small ghost file">Upload photo<input type="file" accept="image/*" hidden></label>
      </div>
      <form class="form" id="paste-f"><label>…or paste the code<input name="qr" autocomplete="off" spellcheck="false" placeholder="upi://pay?pa=…"></label><button class="btn small ghost">Read</button></form>
      <p class="fine">Real-world UPI codes can be paid with DEMO credits only: OMEN has no INR payout partner, so it never sends real crypto toward a payout it can't make. Test USDT pays registered Blockhaven merchants on Whitechain.</p>`);
    bindActs({
      cam: async (b) => {
        b.disabled = true;
        const v = body.querySelector("video");
        v.parentElement.classList.add("on");
        camera = scanCamera(v);
        try {
          const text = await camera.result;
          if (text) parsed(text);
        } catch (e) {
          scanManual(e.name === "NotAllowedError" ? "Camera permission was denied." : e.message);
        }
      },
    });
    body.querySelector("input[type=file]").onchange = async (e) => {
      try {
        parsed(await decodeFile(e.target.files[0]));
      } catch (er) {
        scanManual(er.message);
      }
    };
    body.querySelector("#paste-f").onsubmit = (e) => {
      e.preventDefault();
      const t = new FormData(e.target).get("qr");
      if (t) parsed(String(t));
    };
  }

  function parsed(text) {
    camera?.stop();
    let upi;
    try {
      upi = parseUpiQr(text);
    } catch (e) {
      return scanManual(e.message);
    }
    co.qr = text;
    co.upi = upi;
    co.merchant = merchantByVpa(upi.vpa);
    reviewSetup();
  }

  function reviewSetup(err = "") {
    co.step = "review";
    const m = co.merchant;
    const canUsdt = !!(m && cfg?.checkout && wallet.address);
    const why = !m ? "only for registered Blockhaven merchants" : !cfg?.checkout ? "checkout contract not configured on this server" : !wallet.address ? "connect a wallet first" : "";
    const tok = co.token || (canUsdt ? "USDT" : "DEMO");
    render(`
      <header class="pay-head"><h2 id="pay-h">${m ? esc(m.name) : "Pay"}</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
      ${steps("review", !!err)}
      <div class="scanned">${co.sign ? `<canvas class="qr-mini" aria-label="The QR you scanned"></canvas>` : ""}
        <div><p><b>${esc(co.upi.name || "(no name)")}</b> ${m ? `<span class="badge ok">registered merchant</span>` : `<span class="badge warn">not a Blockhaven merchant</span>`}</p>
        <p><code>${esc(co.upi.vpa)}</code></p>${co.upi.note ? `<p class="muted">“${esc(co.upi.note)}”</p>` : ""}</div></div>
      ${err ? `<p class="err">${esc(err)}</p>` : ""}
      <form class="form" id="q-f">
        ${
          co.upi.amountPaise != null
            ? `<p>Amount in QR: <b>${formatInr(co.upi.amountPaise)}</b></p>`
            : m
              ? `<fieldset class="menu"><legend>What are you buying?</legend>${m.items.map((it, i) => `<label><input type="radio" name="item" value="${it.id}" ${i === 0 ? "checked" : ""}> ${esc(it.name)} <b>${formatInr(it.paise)}</b></label>`).join("")}</fieldset>`
              : `<label>Amount (₹)<input name="amount" inputmode="decimal" required placeholder="0.00" autocomplete="off"></label>`
        }
        <fieldset class="tokens-pick"><legend>Pay with</legend>
          <label class="${canUsdt ? "" : "off"}"><input type="radio" name="token" value="USDT" ${tok === "USDT" && canUsdt ? "checked" : ""} ${canUsdt ? "" : "disabled"}> <b>USDT</b> ${Badge.testnet}<small>${canUsdt ? "Settles on Whitechain Sepolia via the OMEN checkout contract" : esc(why)}</small></label>
          <label><input type="radio" name="token" value="DEMO" ${tok === "DEMO" || !canUsdt ? "checked" : ""}> <b>DEMO credits</b> ${Badge.demo}<small>${formatUnits(demo.balances().DEMO, 2)} available · no blockchain</small></label>
        </fieldset>
        ${!wallet.address && m ? `<button class="link" data-act="connect">Connect a wallet to pay with test USDT</button>` : ""}
        <button class="btn" type="submit" autofocus>Get quote &amp; safety check</button>
      </form>`);
    if (co.sign) {
      const c = body.querySelector(".qr-mini");
      c.width = c.height = co.sign.width;
      c.getContext("2d").drawImage(co.sign, 0, 0);
    }
    bindActs({
      connect: async () => {
        try {
          await wallet.connect();
        } catch (e) {
          return reviewSetup(e.message);
        }
        reviewSetup();
      },
    });
    body.querySelector("#q-f").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      co.token = f.token;
      let qr = co.qr;
      let amountInr;
      if (co.upi.amountPaise == null) {
        if (m) {
          const it = m.items.find((x) => x.id === f.item);
          qr = merchantQr(m, it); // the merchant's own QR for that menu item
          co.item = it;
        } else amountInr = f.amount;
      }
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Quoting…";
      try {
        let p = await api("/payments", { qr, token: f.token, amountInr });
        onStage("quote", { ...co, payment: p });
        btn.textContent = "Checking with 0G…";
        p = await api(`/payments/${p.id}/risk`, {});
        co.payment = p;
        remember(p);
        reviewQuote();
      } catch (er) {
        reviewSetup(er.message);
      }
    };
  }

  function reviewQuote(err = "") {
    const p = co.payment;
    const q = p.quote;
    const blocked = p.state === "BLOCKED";
    const needAck = p.risk?.decision === "review";
    render(`
      <header class="pay-head"><h2 id="pay-h">${esc(p.merchant?.name || p.upi.name || "Review")}</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
      ${steps(blocked ? "review" : "approve", blocked)}
      <table class="quote"><tbody>
        <tr><td>Merchant receives</td><td class="num"><b>${formatInr(q.inrPaise)}</b> ${Badge.sim}</td></tr>
        <tr><td>Gateway fee (${(q.feeBps / 100).toFixed(2)}%)</td><td class="num">${formatInr(q.feePaise)}</td></tr>
        <tr><td>Total</td><td class="num">${formatInr(q.totalPaise)}</td></tr>
        <tr><td>Rate</td><td class="num">1 ${esc(q.token)} = ₹${esc(q.rate)} <small>${q.rateSource === "coingecko" ? "live · CoinGecko" : q.rateSource === "fixed-demo" ? "fixed demo rate" : "fixed fallback rate"}</small></td></tr>
        ${p.mode === "testnet" ? `<tr><td>Network fee</td><td class="num">${cfg?.gasless?.enabled ? `<b>₹0 for you</b> <small>gas paid by the merchant's relayer</small>` : `paid in WBT by your wallet <small>(testnet gas)</small>`}</td></tr>` : ""}
        <tr><td>Recipient</td><td class="num">${esc(p.merchant?.name || p.upi.name || p.upi.vpa)}${p.mode === "testnet" && cfg?.checkout ? ` <small>via checkout <a href="${WHITECHAIN.explorer}/address/${cfg.checkout}" target="_blank" rel="noopener">${short(cfg.checkout)}</a></small>` : ""}</td></tr>
        <tr><td>Network</td><td class="num">${p.mode === "testnet" ? `Whitechain Sepolia <small>testnet · chain ${WHITECHAIN.id}</small>` : "None <small>(DEMO credits in this browser)</small>"}</td></tr>
        <tr><td>Rate as of</td><td class="num">${new Date(q.rateAt || p.createdAt).toLocaleTimeString()} <small>${q.rateSource === "coingecko" ? "CoinGecko" : q.rateSource === "fixed-demo" ? "fixed" : "fallback"}</small></td></tr>
        <tr class="tot"><td>You pay</td><td class="num"><b>${esc(q.tokenAmount)} ${esc(q.token)}</b> ${p.mode === "testnet" ? Badge.testnet : Badge.demo}</td></tr>
      </tbody></table>
      ${q.rateNote ? `<p class="fine">${esc(q.rateNote)}</p>` : ""}
      <div class="risk ${p.risk?.level}">
        <p><b>Safety check:</b> ${riskSummary(p.risk)}</p>
        ${p.risk?.rules.flags.length ? `<ul>${p.risk.rules.flags.map((f) => `<li class="${f.level}">${esc(f.text)}</li>`).join("")}</ul>` : `<p class="muted">No rule warnings.</p>`}
        ${p.risk?.ai?.requestId ? `<p class="fine">0G request ID <code class="wrap">${esc(p.risk.ai.requestId)}</code></p>` : ""}
      </div>
      ${err ? `<p class="err">${esc(err)}</p>` : ""}
      ${
        blocked
          ? `<p class="err">This payment was blocked. Nothing was charged.</p><div class="row-actions"><button class="btn small" data-act="close" autofocus>Close</button></div>`
          : `${needAck ? `<label class="ack"><input type="checkbox" id="ack"> I've read the warnings and still want to pay.</label>` : ""}
             <p class="fine">Quote valid for <b id="ttl"></b>. Nothing moves until you approve${p.mode === "testnet" ? " in your wallet (an approval for exactly this amount, then the payment)" : ""}.</p>
             <div class="row-actions"><button class="btn" data-act="approve" autofocus>${p.mode === "testnet" ? "Approve in wallet" : `Approve: spend ${esc(q.tokenAmount)} DEMO`}</button><button class="btn ghost small" data-act="close">Cancel</button></div>`
      }`);
    onStage(blocked ? "fail" : "review", co);
    const ttl = body.querySelector("#ttl");
    clearInterval(timer);
    const tick = () => {
      const s = Math.max(0, Math.round((q.expiresAt - Date.now()) / 1000));
      if (ttl) ttl.textContent = `${s}s`;
      if (!s) {
        clearInterval(timer);
        const b = body.querySelector("[data-act=approve]");
        if (b) {
          b.disabled = true;
          b.textContent = "Quote expired";
        }
      }
    };
    if (!blocked) {
      tick();
      timer = setInterval(tick, 1000);
    }
    bindActs({ approve: (b) => approve(b) });
  }

  async function approve(b) {
    const p0 = co.payment;
    const ack = body.querySelector("#ack");
    if (ack && !ack.checked) return reviewQuote("Tick the box to confirm you've read the warnings.");
    b.disabled = true;
    clearInterval(timer);
    co.step = "approve";
    onStage("approve", co);
    try {
      let p = await api(`/payments/${p0.id}/authorize`, { payer: wallet.address || undefined, acknowledgeRisk: !!ack?.checked });
      co.payment = p;
      if (p.mode === "testnet") co.balanceBefore = await wallet.usdtBalance().catch(() => null);
      if (p.mode === "testnet" && p.chain.gasless) {
        // Operate flow: one off-chain signature, no transaction, no gas for the payer.
        settling("Sign the payment in your wallet. It's a signature, not a transaction: you pay no gas.");
        const signature = await wallet.signAuthorization(cfg.checkout, p.chain.typedData, p.quote, p.chain.merchantKey);
        onStage("settle", co);
        settling("Signed. The merchant's relayer is settling it on Whitechain (it pays the gas)…");
        p = await api(`/payments/${p.id}/relay`, { signature });
        co.txHash = p.txHash;
        for (let i = 0; i < 30 && p.state === "SUBMITTED"; i++) {
          settling(`Gateway is verifying the receipt on Whitechain… <a href="${txUrl(p.txHash)}" target="_blank" rel="noopener">tx ${short(p.txHash)} ↗</a> ${esc(p.verifyNote || "")}`);
          await new Promise((r) => setTimeout(r, 2000));
          p = await api(`/payments/${p.id}`);
        }
      } else if (p.mode === "testnet") {
        settling("Waiting for your wallet…");
        const hash = await wallet.payCheckout(cfg.checkout, p.chain, (s, h) => {
          if (s === "approve") settling("Approve exactly this USDT amount in your wallet (1 of 2)…");
          if (s === "pay") settling("Confirm the payment in your wallet (2 of 2)…");
          if (s === "sent") {
            co.txHash = h;
            onStage("settle", co);
            settling(`Settling on Whitechain… <a href="${txUrl(h)}" target="_blank" rel="noopener">tx ${short(h)} ↗</a>`);
          }
        });
        p = await api(`/payments/${p.id}/submit`, { txHash: hash });
        for (let i = 0; i < 30 && p.state === "SUBMITTED"; i++) {
          settling(`Gateway is verifying the receipt on Whitechain… ${esc(p.verifyNote || "")}`);
          await new Promise((r) => setTimeout(r, 2000));
          p = await api(`/payments/${p.id}`);
        }
      } else {
        const units = BigInt(p.quote.tokenUnits);
        demo.spend("DEMO", units, { kind: "payment", ref: p.id, to: p.upi.vpa });
        onStage("settle", co);
        settling("Settling DEMO credits (no blockchain)…");
        await new Promise((r) => setTimeout(r, 1400)); // let the village animation play
        try {
          p = await api(`/payments/${p.id}/submit`, { demoRef: "browser-ledger" });
        } catch (e) {
          demo.refund("DEMO", units, p.id);
          throw e;
        }
      }
      co.payment = p;
      // Step 8: the sender's real testnet balance, read back from the chain after settlement.
      if (p.mode === "testnet" && p.state === "COMPLETED") {
        const after = await wallet.usdtBalance().catch(() => null);
        if (after != null) p.balance = { before: co.balanceBefore != null ? formatUnits(co.balanceBefore, 6) : null, after: formatUnits(after, 6) };
      }
      remember(p);
      if (p.state === "COMPLETED") {
        onStage("payout", co);
        await new Promise((r) => setTimeout(r, 900));
        onStage("done", co);
      } else onStage("fail", co);
      co.step = "receipt";
      renderReceipt(p);
    } catch (e) {
      onStage("fail", co);
      const msg = e.code === 4001 || /rejected|denied/i.test(e.shortMessage || e.message) ? "You rejected the request in your wallet. Nothing was paid." : e.shortMessage || e.message;
      if (co.txHash) {
        // The tx exists; only reporting/verifying it failed. Let the player hand it over again.
        render(`<header class="pay-head"><h2 id="pay-h">Payment needs attention</h2><button class="x" data-act="close" aria-label="Close">×</button></header>${steps("settle", true)}<p class="err">${esc(msg)}</p><p><a href="${txUrl(co.txHash)}" target="_blank" rel="noopener">Check the transaction on the explorer ↗</a></p><div class="row-actions"><button class="btn small" data-act="retry" autofocus>Retry verification</button></div>`);
        bindActs({
          retry: async (b) => {
            b.disabled = true;
            try {
              let p = await api(`/payments/${p0.id}/submit`, { txHash: co.txHash });
              for (let i = 0; i < 30 && p.state === "SUBMITTED"; i++) {
                await new Promise((r) => setTimeout(r, 2000));
                p = await api(`/payments/${p0.id}`);
              }
              co.payment = p;
              remember(p);
              onStage(p.state === "COMPLETED" ? "done" : "fail", co);
              co.step = "receipt";
              renderReceipt(p);
            } catch (er) {
              b.disabled = false;
              body.querySelector(".err").textContent = er.message;
            }
          },
        });
      } else {
        const fresh = await api(`/payments/${p0.id}`).catch(() => p0);
        co.payment = fresh;
        if (fresh.state === "AWAITING_WALLET" || fresh.state === "RISK_ASSESSED") {
          // Can't re-authorize a signed-off quote; start a fresh one.
          await api(`/payments/${p0.id}/cancel`, {}).catch(() => {});
          co.payment = null;
          return reviewSetup(msg);
        }
        reviewQuote(msg);
      }
    }
  }

  function settling(html) {
    render(`
      <header class="pay-head"><h2 id="pay-h">Paying ${esc(co.payment.merchant?.name || co.upi.name)}</h2></header>
      ${steps(co.txHash || co.payment.mode === "demo" ? "settle" : "approve")}
      <div class="settling"><div class="spinner" aria-hidden="true"></div><p>${html}</p></div>
      <p class="fine">${co.payment.mode === "testnet" ? Badge.testnet + " USDT moves on Whitechain Sepolia. " : Badge.demo + " "}${Badge.sim} The rupee payout to the merchant is simulated.</p>`, false);
  }

  // ------------------------------------------------------------------ tutorial
  function renderTutorial(next) {
    view = "tutorial";
    const cards = [
      ["1 · Scan", "Walk up to a merchant's QR sign and press <b>E</b>. The game reads the painted QR (a standard UPI code). Out in the real world, scan with your camera from the Wallet.", "scan"],
      ["2 · Approve", "You see the merchant's INR price, the gateway fee, the live rate and exactly what you'll pay. A safety check runs (rules + 0G AI). <b>Nothing moves until you approve</b> in your wallet.", "approve"],
      ["3 · Settle", `Test USDT settles on <b>Whitechain Sepolia</b> through OMEN's checkout contract ${Badge.testnet}. The rupee payout to the merchant is <b>simulated</b> ${Badge.sim}. Or play with 1,000,000 DEMO credits ${Badge.demo}.`, "settle"],
    ];
    let i = 0;
    const draw = () => {
      const [h, t, k] = cards[i];
      render(`
        <header class="pay-head"><h2 id="pay-h">How paying works</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
        <div class="tut tut-${k}"><div class="tut-art" aria-hidden="true">${TUT_ART[k]}</div><h3>${h}</h3><p>${t}</p></div>
        <div class="row-actions tut-nav"><span class="dots">${cards.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("")}</span>
          ${i > 0 ? `<button class="btn small ghost" data-act="prev">Back</button>` : ""}
          <button class="btn small" data-act="next" autofocus>${i < cards.length - 1 ? "Next" : "Got it"}</button></div>`);
      bindActs({
        prev: () => (i--, draw()),
        next: () => {
          if (i < cards.length - 1) return i++, draw();
          store.set("omen.tutorial.seen", true);
          next();
        },
      });
    };
    draw();
  }

  return {
    isOpen,
    openWallet,
    startCheckout,
    close,
    /** Remember a story delivery so the player can write it to Arkiv. */
    logDelivery(d) {
      if (deliveries.some((x) => x.id === d.id)) return;
      deliveries.push({ ...d, at: Date.now() });
      store.set("omen.deliveries.v1", deliveries);
    },
    /** QR canvas for a merchant's in-world sign (a static UPI QR: no amount, like a real stall). */
    signCanvas(merchantId) {
      const m = merchantById(merchantId);
      return qrCanvas(merchantQr(m), 264);
    },
    merchants: MERCHANTS,
    _wallet: wallet,
  };
}

const TUT_ART = {
  scan: `<svg viewBox="0 0 120 80"><rect x="38" y="8" width="44" height="60" rx="6" fill="#FBF3E4" stroke="#2B2230" stroke-width="3"/><g fill="#2B2230"><rect x="46" y="17" width="10" height="10"/><rect x="64" y="17" width="10" height="10"/><rect x="46" y="35" width="10" height="10"/><rect x="62" y="37" width="4" height="4"/><rect x="69" y="41" width="5" height="4"/><rect x="62" y="45" width="5" height="5"/></g><path d="M30 30h-8M30 50h-8M98 30h-8M98 50h-8" stroke="#3E8E8A" stroke-width="3" stroke-linecap="round"/></svg>`,
  approve: `<svg viewBox="0 0 120 80"><rect x="22" y="14" width="76" height="52" rx="8" fill="#F3D98B" stroke="#2B2230" stroke-width="3"/><path d="M44 41l10 10 22-22" fill="none" stroke="#2B2230" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  settle: `<svg viewBox="0 0 120 80"><circle cx="24" cy="44" r="12" fill="#6FE3D6" stroke="#2B2230" stroke-width="3"/><path d="M40 44h40" stroke="#2B2230" stroke-width="3" stroke-dasharray="5 5"/><path d="M76 36l9 8-9 8" fill="none" stroke="#2B2230" stroke-width="3" stroke-linecap="round"/><rect x="88" y="30" width="22" height="28" rx="4" fill="#B85C4A" stroke="#2B2230" stroke-width="3"/><text x="99" y="49" font-size="15" text-anchor="middle" fill="#FBF3E4" font-family="sans-serif" font-weight="800">₹</text></svg>`,
};
