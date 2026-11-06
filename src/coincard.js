// The field-guide card for a crypto discovery: live CoinGecko data via OMEN's backend cache.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const money = (v, cur) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const digits = v >= 100 ? 0 : v >= 1 ? 2 : 4;
  return new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US", { style: "currency", currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
};
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
function launchText(l) {
  if (!l.date) return `<b>Unknown</b><small>${esc(l.label)}</small>`;
  const [y, m, d] = l.date.split("-");
  const when = d ? day(l.date) : m ? new Date(Number(y), Number(m) - 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" }) : y;
  return `<b>${esc(when)}</b><small>${esc(l.label)} · ${l.source === "coingecko" ? "CoinGecko genesis date" : "OMEN's note (CoinGecko lists no genesis date)"}</small>`;
}

function chartSvg(points) {
  if (!points?.length) return `<p class="cc-nochart">Chart unavailable right now.</p>`;
  const W = 300;
  const H = 86;
  const ys = points.map((p) => p[1]);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - 6 - ((p[1] - min) / span) * (H - 14)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const up = ys[ys.length - 1] >= ys[0];
  return `<svg class="cc-chart ${up ? "up" : "down"}" viewBox="0 0 ${W} ${H}" role="img" aria-label="30-day price in US dollars, from ${money(ys[0], "USD")} to ${money(ys[ys.length - 1], "USD")}">
    <path class="area" d="${line}L${W},${H}L0,${H}Z"/><path class="line" d="${line}"/></svg>
    <div class="cc-axis"><span>30 days ago</span><span>low ${money(min, "USD")} · high ${money(max, "USD")}</span><span>today</span></div>`;
}

export function createCoinCard({ onOpenChange = () => {} } = {}) {
  const root = document.createElement("div");
  root.id = "coin-card";
  root.hidden = true;
  root.innerHTML = `<div class="cc-back"></div><article class="cc-sheet" role="dialog" aria-modal="true" aria-labelledby="cc-h"><div class="cc-body"></div></article>`;
  document.body.append(root);
  const body = root.querySelector(".cc-body");
  let token = 0;
  const close = () => {
    if (root.hidden) return;
    if (root.contains(document.activeElement)) document.activeElement.blur();
    root.hidden = true;
    token++;
    onOpenChange(false);
  };
  root.querySelector(".cc-back").onclick = close;
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  });

  async function open(def, { firstFind = false } = {}) {
    const my = ++token;
    root.hidden = false;
    onOpenChange(true);
    body.innerHTML = `<header class="cc-head"><span class="cc-glyph" style="background:${def.face};border-color:${def.rim}">${esc(def.glyph)}</span><div><p class="cc-kicker">${firstFind ? "New discovery!" : "Field guide"}</p><h2 id="cc-h">${esc(def.name)}</h2></div><button class="x" aria-label="Close">×</button></header><p class="cc-loading">Fetching live market data…</p>`;
    body.querySelector(".x").onclick = close;
    body.querySelector(".x").focus();
    let d;
    try {
      const r = await fetch(`/api/market/${def.sym}`);
      d = await r.json();
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
    } catch (e) {
      if (my !== token) return;
      body.querySelector(".cc-loading").outerHTML = `<p class="cc-err">Live prices are unavailable right now (${esc(e.message)}). OMEN never shows made-up prices, so try again in a minute.</p>`;
      return;
    }
    if (my !== token) return; // closed or reopened meanwhile
    const ch = d.change24h;
    body.innerHTML = `
      <header class="cc-head"><span class="cc-glyph" style="background:${def.face};border-color:${def.rim}">${esc(def.glyph)}</span>
        <div><p class="cc-kicker">${firstFind ? "New discovery!" : "Field guide"}</p><h2 id="cc-h">${esc(d.name)} <span class="cc-tick">${esc(d.symbol)}</span></h2></div>
        <button class="x" aria-label="Close">×</button></header>
      ${d.stale ? `<p class="cc-stale">Showing the last good data from ${ago(d.fetchedAt)}: CoinGecko isn't answering right now (${esc(d.staleReason || "")}).</p>` : ""}
      <div class="cc-price"><b>${money(d.price.inr, "INR")}</b><span>${money(d.price.usd, "USD")}</span>
        <span class="cc-ch ${ch >= 0 ? "up" : "down"}">${ch == null ? "—" : `${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch).toFixed(2)}%`} <small>24 h</small></span></div>
      ${chartSvg(d.chart?.points)}
      <dl class="cc-facts">
        <div><dt>Launched</dt><dd>${launchText(d.launch)}</dd></div>
        <div><dt>All-time high</dt><dd><b>${money(d.ath.inr, "INR")}</b><small>${money(d.ath.usd, "USD")} · ${day(d.ath.date)}</small></dd></div>
        <div><dt>All-time low</dt><dd><b>${money(d.atl.inr, "INR")}</b><small>${money(d.atl.usd, "USD")} · ${day(d.atl.date)}</small></dd></div>
      </dl>
      <p class="cc-about">${esc(d.about)}</p>
      <p class="cc-meta">Price updated ${d.lastUpdated ? new Date(d.lastUpdated).toLocaleTimeString() : "—"} (CoinGecko) · fetched by OMEN ${ago(d.fetchedAt)} · data: CoinGecko</p>
      <p class="cc-note">An educational collectible: finding it adds nothing to any wallet.</p>`;
    body.querySelector(".x").onclick = close;
    body.querySelector(".x").focus();
  }

  return { open, close, isOpen: () => !root.hidden };
}
