// The station sheet: what you see when you press E at an exhibitor station.
// Real hooks only: Arkiv runs OMEN's existing read-only record query; the Mentor Station asks
// OMEN's existing Alfred advisor. Nothing here writes, pays or signs.
import { authed } from "../identity.js";
import { ARKIV } from "../../shared/chains.js";
import { BRANDS } from "./stations.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const NOTE = `<p class="fine">This stand recreates an exhibitor from the hall at ETHGlobal Mumbai for OMEN's venue. OMEN isn't affiliated with or endorsed by it. In a later phase its screens become player-claimed ad inventory.</p>`;

export function createPanel({ onOpenChange, toast, myName, onCheer }) {
  const root = document.createElement("div");
  root.id = "station";
  root.hidden = true;
  root.innerHTML = `<section class="st-sheet" role="dialog" aria-modal="true" aria-labelledby="st-h"><div class="st-body"></div></section>`;
  document.body.append(root);
  const body = root.querySelector(".st-body");
  root.addEventListener("click", (e) => e.target === root && close());
  root.addEventListener("keydown", (e) => {
    e.stopPropagation(); // WASD stays in the sheet
    if (e.key === "Escape") close();
  });
  // Escape closes the sheet even when focus has left it (e.g. after a button is disabled mid-request)
  document.addEventListener("keydown", (e) => e.key === "Escape" && !root.hidden && close());
  let current = null;
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    current = null;
    onOpenChange(false);
  }
  function show(st, html) {
    current = st.key;
    body.innerHTML = `<header class="st-head"><h2 id="st-h">${esc(st.name)}</h2><button class="x" data-close aria-label="Close">×</button></header>${html}`;
    body.querySelector("[data-close]").onclick = close;
    if (root.hidden) {
      root.hidden = false;
      onOpenChange(true);
    }
    (body.querySelector("[autofocus]") || body.querySelector("button, input"))?.focus({ preventScroll: true });
  }

  function open(st) {
    if (st.key === "arkiv") return arkiv(st);
    if (st.kind === "mentor") return mentor(st);
    if (st.kind === "food") {
      onCheer();
      toast("You picked up a masala chai. On the house (it's a game).", 3600);
      return;
    }
    if (st.kind === "washroom") return toast("Washrooms: on your left, behind the doors. Back on the corridor in a moment.", 3600);
    const b = BRANDS[st.key];
    show(st, `${b?.tagline ? `<p class="st-tag">${b.tagline.map(esc).join(" · ")}</p>` : ""}
      <p>${esc(st.name)} has a stand on Pavilion 2's exhibitor corridor. Stop by the counter to meet the team.</p>${NOTE}
      <div class="row-actions"><button class="btn small" data-close2 autofocus>Back to the corridor</button></div>`);
    body.querySelector("[data-close2]").onclick = close;
  }

  function arkiv(st) {
    show(st, `<p class="st-tag">[ ARKIV ] · the Web3 database · owned · queryable · time-scoped</p>
      <p>OMEN already uses Arkiv: after a payment, a player can save a <b>read-only receipt</b> (schema <code>omen.record.v1</code>, kept 30 days) on the ${esc(ARKIV.name)}, signed from their own wallet in Blockhaven.</p>
      <form id="ark-f" class="st-form"><label>Look up OMEN records owned by a wallet<input name="owner" placeholder="0x…" pattern="0x[0-9a-fA-F]{40}" required autocomplete="off" spellcheck="false"></label>
        <button class="btn small">Search Arkiv</button></form>
      <div id="ark-out" aria-live="polite"></div>
      <p class="fine">A public read straight from the Arkiv testnet: no wallet, no signature, nothing written. <a href="${ARKIV.explorer}" target="_blank" rel="noopener noreferrer">Arkiv explorer ↗</a></p>${NOTE}`);
    body.querySelector("#ark-f").onsubmit = async (e) => {
      e.preventDefault();
      const owner = e.target.owner.value.trim();
      const out = body.querySelector("#ark-out");
      out.innerHTML = `<p class="fine">Asking Arkiv…</p>`;
      try {
        const { queryRecords } = await import("../pay/arkiv.js"); // loaded only when someone asks
        const rows = await queryRecords(owner);
        out.innerHTML = rows.length
          ? `<p><b>${rows.length}</b> OMEN record${rows.length > 1 ? "s" : ""} on Arkiv for this wallet:</p><ul class="st-list">${rows.slice(0, 6).map((r) => `<li><b>${esc(r.kind)}</b> · ${esc(r.mode)} · ${esc(r.merchant)} · ${esc(r.status)} <small>${r.createdAt ? new Date(Number(r.createdAt)).toLocaleString() : ""}</small></li>`).join("")}</ul>`
          : `<p>No OMEN records for this wallet on Arkiv yet. Save a receipt from the wallet in Blockhaven to create one.</p>`;
      } catch (er) {
        out.innerHTML = `<p class="err">Arkiv couldn't be reached right now (${esc(er.shortMessage || er.message || er)}). Nothing was written.</p>`;
      }
    };
  }

  function mentor(st) {
    show(st, `<p class="st-tag">Mentor Station · ask for help</p>
      <p>Stuck on your build? Pull up a chair. Alfred, OMEN's advisor, takes the first question.</p>
      <form id="mentor-f" class="st-form"><label>Your question<textarea name="q" rows="2" maxlength="300" required placeholder="How do I get my first customer?"></textarea></label>
        <button class="btn small">Ask Alfred</button></form>
      <div id="mentor-out" aria-live="polite"></div>`);
    body.querySelector("#mentor-f").onsubmit = async (e) => {
      e.preventDefault();
      const out = body.querySelector("#mentor-out");
      const btn = e.target.querySelector("button");
      btn.disabled = true;
      out.innerHTML = `<p class="fine">Alfred is thinking…</p>`;
      try {
        const r = await authed("/api/alfred", { method: "POST", body: { name: myName(), text: e.target.q.value.trim(), context: {} } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`);
        out.innerHTML = `<blockquote class="st-reply">${esc(j.reply)}</blockquote><p class="fine">${esc(j.label || "")}</p>`;
      } catch (er) {
        out.innerHTML = `<p class="err">Alfred isn't reachable from here right now (${esc(er.message)}). Find him on his bench in Blockhaven village.</p>`;
      }
      btn.disabled = false;
    };
  }

  return {
    open,
    close,
    get isOpen() {
      return !root.hidden;
    },
    get current() {
      return current;
    },
  };
}
