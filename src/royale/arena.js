// Bounty Royale arena: the shared, live prediction game. The server owns every number shown here;
// this file renders /api/royale/state and asks the server to stake. Free OMEN points only.
import { io } from "socket.io-client";
import { human } from "../final/gate.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = (v) => Number(v || 0).toLocaleString("en-IN");
const TABS = [
  { id: "top3", name: "Top Three" },
  { id: "bounty", name: "Sponsor Bounties" },
  { id: "double", name: "Double Crown" },
  { id: "wildcard", name: "Game Wildcard" },
  { id: "board", name: "Leaderboard" },
  { id: "mine", name: "My picks" },
];

async function api(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error, status: r.status });
  return j;
}

export function createArena({ getName = () => "Courier", onOpen = () => {}, onClose = () => {}, socket = null } = {}) {
  const el = document.createElement("section");
  el.id = "royale";
  el.hidden = true;
  el.setAttribute("aria-label", "Bounty Royale");
  document.body.append(el);

  let state = null;
  let tab = "top3";
  let sponsor = null;
  let query = "";
  let online = 0;
  let sock = null;
  let skew = 0; // server clock − local clock
  let draft = null; // { marketId, selection, label }
  let receipt = null;
  let flash = "";
  let refreshT = 0;

  const projectName = (id) => (id === "yes" ? "Yes" : id === "no" ? "No" : state?.projects.find((p) => p.id === id)?.name || id);
  const left = (iso) => {
    const ms = new Date(iso) - (Date.now() + skew);
    if (ms <= 0) return "locked";
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h ${m}m` : `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  async function load() {
    state = await api("/api/royale/state");
    skew = new Date(state.serverTime) - Date.now();
    if (!sponsor) sponsor = state.markets.find((m) => m.mode === "bounty")?.id;
  }
  const refresh = () => {
    clearTimeout(refreshT);
    refreshT = setTimeout(async () => {
      if (el.hidden) return;
      try {
        await load();
        render();
      } catch {
        /* keep the last good view */
      }
    }, 120);
  };

  function connect() {
    if (sock) return;
    sock = socket || io("/royale", { path: "/royale-io/", transports: ["websocket"] }); // one connection per page, shared with the venue scoreboard
    sock.on("royale:changed", refresh);
    sock.on("connect", refresh); // resync after any reconnect
    if (Number.isInteger(sock.online)) online = sock.online; // a shared socket already knows the count
    sock.on("royale:presence", (p) => {
      online = sock.online = p.online;
      const o = el.querySelector("[data-online]");
      if (o) o.textContent = online;
    });
    sock.on("royale:activity", (a) => {
      if (a.type === "stake") pulse();
    });
    sock.on("royale:reveal", async (r) => {
      await load().catch(() => {});
      const m = state?.markets.find((x) => x.id === r.marketId);
      const mine = state?.me?.predictions.filter((p) => p.market_id === r.marketId) || [];
      const won = mine.filter((p) => p.outcome === "won").reduce((a, p) => a + p.payout, 0);
      const refunded = mine.some((p) => p.outcome === "refunded");
      reveal(m, won, refunded);
      render();
    });
  }

  function pulse() {
    const a = el.querySelector(".ra-activity");
    a?.classList.remove("pulse");
    void a?.offsetWidth;
    a?.classList.add("pulse");
  }

  function reveal(m, won, refunded) {
    const box = document.createElement("div");
    box.className = "ra-reveal";
    box.innerHTML = `<div><p class="ra-kick">Official result</p><h3>${esc(m?.title || "Market settled")}</h3>
      <p>${m?.status === "void" ? "Voided — every stake refunded." : `Winners: <b>${(m?.winners || []).map((w) => esc(projectName(w))).join(", ")}</b>`}</p>
      ${won ? `<p class="ra-win">You scored +${n(won)} points!</p>` : refunded ? `<p>Your stake was refunded.</p>` : ""}
      <button class="btn small" type="button">Nice</button></div>`;
    if (won) for (let i = 0; i < 26; i++) {
      const c = document.createElement("i");
      c.className = "ra-confetti";
      c.style.left = `${Math.random() * 100}%`;
      c.style.animationDelay = `${Math.random() * 0.6}s`;
      c.style.background = ["#F3D98B", "#3E8E8A", "#C8473D", "#6FE3D6"][i % 4];
      box.append(c);
    }
    document.body.append(box); // outside the arena: its once-a-second re-render must not wipe the reveal
    box.querySelector("button").onclick = () => box.remove();
    setTimeout(() => box.remove(), 9000);
  }

  // ------------------------------------------------------------------ render
  function marketCard(m) {
    const mine = state.me?.predictions.filter((p) => p.market_id === m.id) || [];
    const open = m.status === "open";
    const canPick = open && state.me && mine.length < m.maxPicks;
    const sel = new Map(m.selections.map((s) => [s.selection, s]));
    const options = m.kind === "yesno" ? [{ id: "yes", name: "Yes" }, { id: "no", name: "No" }] : state.projects.filter((p) => !query || `${p.name} ${p.team}`.toLowerCase().includes(query.toLowerCase()));
    const ordered = m.kind === "yesno" ? options : [...options].sort((a, b) => (sel.get(b.id)?.points || 0) - (sel.get(a.id)?.points || 0));
    return `<article class="ra-market" data-market="${esc(m.id)}">
      <header><h3>${esc(m.title)}</h3><span class="ra-status ${m.status}">${m.status === "open" ? `locks in ${left(m.lockAt)}` : m.status}</span></header>
      <p class="ra-meta">Pool <b>${n(m.pool)}</b> pts · ${m.players} player${m.players === 1 ? "" : "s"} · up to ${m.maxPicks} pick${m.maxPicks > 1 ? "s" : ""}${mine.length ? ` · you: ${mine.map((p) => `${esc(projectName(p.selection))} ${n(p.amount)}`).join(", ")}` : ""}</p>
      ${m.winners ? `<p class="ra-result">${m.status === "void" ? "Voided: stakes refunded." : `Official winners: <b>${m.winners.map((w) => esc(projectName(w))).join(", ")}</b>`}${m.resultSource ? ` <small>(${esc(m.resultSource)})</small>` : ""}</p>` : ""}
      ${m.kind === "projects" && !state.projects.length ? `<p class="ra-fine">No teams yet: moderators import the official project list (or switch on clearly labelled DEMO teams for testing).</p>` : ""}
      <ul class="ra-options">${ordered
        .slice(0, 60)
        .map((o) => {
          const s = sel.get(o.id);
          const pct = s ? Math.round(s.share * 100) : 0;
          const picked = mine.some((p) => p.selection === o.id);
          const won = m.winners?.includes(o.id);
          return `<li class="${picked ? "picked" : ""} ${won ? "won" : ""}"><span class="ra-name">${esc(o.name)}${o.team ? ` <small>${esc(o.team)}</small>` : ""}${o.isGame ? ' <small class="ra-tag">game</small>' : ""}${o.demo ? ' <small class="ra-tag demo">DEMO</small>' : ""}</span>
            <span class="bar"><i style="width:${pct}%"></i></span><small class="ra-pct">${pct}% · ${n(s?.points)}</small>
            ${canPick && !picked ? `<button class="btn small ghost" type="button" data-pick="${esc(o.id)}">Pick</button>` : picked ? `<b class="ra-mine">yours</b>` : ""}</li>`;
        })
        .join("")}</ul></article>`;
  }

  function body() {
    if (tab === "board")
      return `<ol class="ra-board">${state.leaderboard.map((b) => `<li class="${b.me ? "me" : ""}"><span>#${b.rank}</span><span>${esc(b.name)}</span><b>${n(b.score)}</b><small>won ${n(b.won)}</small></li>`).join("") || "<li>No players yet.</li>"}</ol>
        <p class="ra-fine">Score = available points + points in open picks. ${esc(state.rules.scoring)}</p>`;
    if (tab === "mine") {
      if (!state.me) return `<p class="ra-fine">Verify with World ID and enter to make picks.</p>`;
      return `<table class="ra-hist"><thead><tr><th>Market</th><th>Pick</th><th>Points</th><th>Result</th></tr></thead><tbody>${state.me.predictions
        .map((p) => `<tr><td>${esc(state.markets.find((m) => m.id === p.market_id)?.title || p.market_id)}</td><td>${esc(projectName(p.selection))}</td><td>${n(p.amount)}</td><td>${p.outcome ? `${p.outcome}${p.payout ? ` +${n(p.payout)}` : ""}` : "open"}</td></tr>`)
        .join("") || `<tr><td colspan="4">No picks yet.</td></tr>`}</tbody></table>
        <button class="linkish" type="button" data-ledger>Show full points ledger</button><div class="ra-ledger"></div>`;
    }
    const markets = state.markets.filter((m) => m.mode === tab);
    const search = tab !== "wildcard" ? `<input class="ra-search" type="search" placeholder="Search teams" value="${esc(query)}" aria-label="Search teams">` : "";
    if (tab === "bounty")
      return `<p class="ra-rule">${esc(state.rules.modes.bounty)}</p><div class="ra-chips">${markets.map((m) => `<button type="button" class="chip ${m.id === sponsor ? "on" : ""}" data-sponsor="${esc(m.id)}">${esc(m.sponsor || m.title)}</button>`).join("")}</div>${search}${markets.filter((m) => m.id === sponsor).map(marketCard).join("")}`;
    return `<p class="ra-rule">${esc(state.rules.modes[tab])}</p>${search}${markets.map(marketCard).join("")}`;
  }

  function render() {
    if (!state) return;
    const me = state.me;
    const nextLock = state.markets.filter((m) => m.status === "open").map((m) => m.lockAt).sort()[0];
    el.innerHTML = `<div class="ra-card">
      <header class="ra-head">
        <div><p class="ra-kick">ETHGlobal Mumbai prediction arena</p><h2>Bounty Royale</h2></div>
        <div class="ra-stats">
          ${me ? `<p><small>Available</small><b data-balance>${n(me.balance)}</b></p><p><small>Committed</small><b>${n(me.committed)}</b></p>` : ""}
          <p><small>Online</small><b data-online>${online}</b></p>
          ${nextLock ? `<p><small>Next lock</small><b>${left(nextLock)}</b></p>` : ""}
        </div>
        <button class="ra-x" type="button" aria-label="Close">×</button>
      </header>
      <p class="ra-label">${esc(state.label)}</p>
      ${state.demoMode ? `<p class="ra-demo">DEMO MODE — sample teams for testing only. They are not ETHGlobal entrants and nothing here is an official result.</p>` : ""}
      ${!me ? join() : ""}
      ${flash ? `<p class="ra-flash">${esc(flash)}</p>` : ""}
      <nav class="ra-tabs" role="tablist">${TABS.map((t) => `<button role="tab" type="button" aria-selected="${t.id === tab}" data-tab="${t.id}">${t.name}</button>`).join("")}</nav>
      <div class="ra-body">${body()}</div>
      <aside class="ra-activity"><h4>Live activity</h4><ul>${state.activity.map((a) => `<li><b>${esc(a.name)}</b> put ${n(a.amount)} on ${esc(projectName(a.selection))} <small>${esc(state.markets.find((m) => m.id === a.marketId)?.sponsor || state.markets.find((m) => m.id === a.marketId)?.title || "")}</small></li>`).join("") || "<li>Quiet so far.</li>"}</ul></aside>
      <details class="ra-rules"><summary>Published rules</summary><ul>${["points", "staking", "lock", "scoring", "refunds", "results"].map((k) => `<li>${esc(state.rules[k])}</li>`).join("")}</ul></details>
      ${draft ? confirmBox() : receipt ? receiptBox() : ""}
    </div>`;
    wire();
  }

  function join() {
    if (!human.current) return `<div class="ra-join"><p>Spectating. Only World ID-verified humans get points and can pick.${human.guest ? " You're playing UNVERIFIED (dev)." : ""}</p></div>`;
    return `<div class="ra-join"><p>Get your one-time <b>1,000 free OMEN points</b>. Non-transferable, non-redeemable.</p><button class="btn" type="button" data-join>Claim points & enter</button></div>`;
  }

  function confirmBox() {
    const m = state.markets.find((x) => x.id === draft.marketId);
    const bal = state.me?.balance || 0;
    const max = Math.min(bal, 1000);
    const amt = Math.max(1, Math.min(max, Number(draft.amount) || Math.min(100, max)));
    const p = state.projects.find((x) => x.id === draft.selection);
    return `<div class="ra-confirm" role="dialog" aria-label="Confirm prediction"><form>
      <p class="ra-kick">Confirm prediction</p>
      <h3>${esc(draft.label)}${p?.demo ? ' <small class="ra-tag demo">DEMO</small>' : ""}</h3>
      <dl class="ra-sum">
        <dt>Market</dt><dd>${esc(m?.title)}</dd>
        ${m?.sponsor ? `<dt>Sponsor bounty</dt><dd>${esc(m.sponsor)}</dd>` : ""}
        <dt>Locks</dt><dd>${esc(new Date(m?.lockAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }))} (${esc(left(m?.lockAt))})</dd>
        <dt>Points to commit</dt><dd><input name="amount" type="number" inputmode="numeric" min="1" max="${max}" step="1" value="${amt}" required aria-label="Points to commit"></dd>
        <dt>Balance after</dt><dd data-after>${n(bal - amt)} available</dd>
      </dl>
      ${draft.error ? `<p class="err">${esc(draft.error)}</p>` : ""}
      <p class="ra-fine">Free OMEN points only. Once confirmed, points leave your balance and the pick can't be edited or withdrawn.</p>
      <button class="btn ra-big" type="submit">CONFIRM PREDICTION</button>
      <button class="btn ghost" type="button" data-cancel>Cancel</button>
    </form></div>`;
  }

  function receiptBox() {
    const r = receipt;
    return `<div class="ra-confirm" role="dialog" aria-label="Prediction receipt"><div class="ra-receipt">
      <p class="ra-kick">Prediction locked ✓</p>
      <h3>${esc(r.label)}</h3>
      <dl class="ra-sum"><dt>Market</dt><dd>${esc(r.market)}</dd><dt>Committed</dt><dd>${n(r.amount)} pts</dd><dt>Available now</dt><dd>${n(r.balance)} pts</dd><dt>Receipt</dt><dd><code>${esc(r.id)}</code></dd><dt>Time (server)</dt><dd>${esc(new Date(r.at).toLocaleString("en-IN"))}</dd></dl>
      <button class="btn ra-big" type="button" data-receipt-ok>Done</button></div></div>`;
  }

  function wire() {
    el.querySelector(".ra-x").onclick = close;
    for (const b of el.querySelectorAll("[data-tab]")) b.onclick = () => ((tab = b.dataset.tab), render());
    for (const b of el.querySelectorAll("[data-sponsor]")) b.onclick = () => ((sponsor = b.dataset.sponsor), render());
    const s = el.querySelector(".ra-search");
    if (s)
      s.oninput = () => {
        query = s.value;
        const pos = s.selectionStart;
        render();
        const again = el.querySelector(".ra-search");
        again?.focus();
        again?.setSelectionRange(pos, pos);
      };
    el.querySelector("[data-join]")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        state = await api("/api/royale/join", { name: getName() });
        flash = state.granted ? "1,000 points added. Good luck!" : "Welcome back.";
      } catch (err) {
        flash = err.message;
      }
      render();
    });
    for (const b of el.querySelectorAll("[data-pick]"))
      b.onclick = () => {
        draft = { marketId: b.closest("[data-market]").dataset.market, selection: b.dataset.pick, label: projectName(b.dataset.pick), key: crypto.randomUUID() };
        render();
        el.querySelector(".ra-confirm input")?.focus();
      };
    el.querySelector("[data-cancel]")?.addEventListener("click", () => ((draft = null), render()));
    const f = el.querySelector(".ra-confirm form");
    if (f) {
      const input = f.querySelector("input[name=amount]");
      input.oninput = () => {
        draft.amount = input.value;
        const v = Math.max(0, Math.floor(Number(input.value) || 0));
        f.querySelector("[data-after]").textContent = `${n((state.me?.balance || 0) - v)} available`;
      };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector("button[type=submit]");
        btn.disabled = true;
        btn.textContent = "Locking…";
        const amount = Math.floor(Number(input.value));
        try {
          // the same key is reused if this exact submission is retried, so it can't charge twice
          state = await api("/api/royale/predictions", { marketId: draft.marketId, selection: draft.selection, amount, idempotencyKey: draft.key });
          receipt = { label: draft.label, market: state.markets.find((m) => m.id === draft.marketId)?.title, amount: state.prediction.amount, balance: state.me.balance, id: state.prediction.id, at: state.prediction.created_at };
          flash = `Locked: ${n(state.prediction.amount)} on ${draft.label}.`;
          draft = null;
        } catch (err) {
          const why = { insufficient_points: "Not enough points for that amount.", market_locked: "This market has locked: predictions are closed.", duplicate: "You already have this pick in this market.", max_picks: err.message, bad_amount: err.message }[err.code] || err.message;
          if (["market_locked", "duplicate", "max_picks"].includes(err.code)) {
            flash = why;
            draft = null;
            await load().catch(() => {});
          } else draft.error = why;
        }
        render();
      };
    }
    el.querySelector("[data-receipt-ok]")?.addEventListener("click", () => ((receipt = null), (tab = "mine"), render()));
    el.querySelector("[data-ledger]")?.addEventListener("click", async () => {
      const { ledger } = await api("/api/royale/ledger");
      el.querySelector(".ra-ledger").innerHTML = `<table class="ra-hist"><tbody>${ledger.map((l) => `<tr><td>${new Date(l.created_at).toLocaleString()}</td><td>${esc(l.kind)}</td><td>${l.delta > 0 ? "+" : ""}${n(l.delta)}</td><td>= ${n(l.balance_after)}</td></tr>`).join("")}</tbody></table>`;
    });
  }

  let tick = 0;
  async function open(startTab) {
    if (startTab) tab = startTab;
    el.hidden = false;
    el.innerHTML = `<div class="ra-card"><p class="loading">Entering Bounty Royale…</p></div>`;
    onOpen();
    connect();
    try {
      await load();
      render();
    } catch (e) {
      el.innerHTML = `<div class="ra-card"><p class="err">${esc(e.message)}</p><button class="btn small" type="button">Close</button></div>`;
      el.querySelector("button").onclick = close;
    }
    clearInterval(tick);
    tick = setInterval(() => !draft && !receipt && !el.querySelector(".ra-search:focus") && render(), 1000); // countdowns
  }
  function close() {
    el.hidden = true;
    draft = null;
    clearInterval(tick);
    onClose();
  }
  return { open, close, get isOpen() { return !el.hidden; }, get state() { return state; } };
}
