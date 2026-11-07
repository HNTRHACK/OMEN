// Bounty Royale moderation: import teams, DEMO teams, deadlines, close / settle / void.
// Every action is authorised on the server (existing moderator accounts, HttpOnly session cookie).
import "../style.css";
import "../btcinr/pay.css";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? "POST" : "GET"), credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { status: r.status });
  return j;
}
let msg = "";

async function render() {
  let mod = null;
  try {
    mod = (await api("/api/royale/mod/me")).moderator;
  } catch {
    /* not signed in */
  }
  if (!mod) {
    $("#app").innerHTML = `<section class="card"><h2>Moderator sign-in</h2>
      <form id="login" class="form"><label>Username<input name="u" autocomplete="username" required></label><label>Password<input name="p" type="password" autocomplete="current-password" required></label><button class="btn">Sign in</button></form>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}</section>`;
    $("#login").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api("/api/mod/login", { username: f.get("u"), password: f.get("p") });
        msg = "";
      } catch (err) {
        msg = err.message;
      }
      render();
    };
    return;
  }
  const st = await api("/api/royale/state");
  const teams = st.projects;
  $("#app").innerHTML = `
    <p class="fine">Signed in as <b>${esc(mod.username)}</b> (${esc(mod.role)}). Free OMEN points only. Enter only official ETHGlobal results.</p>
    ${msg ? `<p class="${msg.startsWith("✓") ? "ok" : "err"}">${esc(msg)}</p>` : ""}
    <section class="card"><h2>Teams (${teams.length})</h2>
      <p class="fine">Paste the official project list, one per line: <code>Project name | team | https://url | game</code> (team, url and "game" optional).</p>
      <form id="imp" class="form"><textarea name="t" rows="6" style="font:inherit;width:100%"></textarea><button class="btn small">Import teams</button></form>
      <p class="row-actions"><button class="btn small ghost" id="demo-on">Switch on 3 DEMO teams</button><button class="btn small ghost" id="demo-off">Remove DEMO teams</button></p>
      <ul class="hist">${teams.map((t) => `<li>${esc(t.name)} <small>${esc(t.team)} ${t.isGame ? "· game" : ""} ${t.demo ? "· <b>DEMO</b>" : ""}</small> <code>${esc(t.id)}</code></li>`).join("")}</ul>
    </section>
    <section class="card"><h2>Markets</h2>${st.markets
      .map(
        (m) => `<form class="form mk" data-id="${esc(m.id)}" style="border-top:2px dashed;padding-top:8px">
        <b>${esc(m.title)}</b> <small>${esc(m.id)} · ${esc(m.status)} · pool ${m.pool} · locks ${esc(new Date(m.lockAt).toLocaleString("en-IN"))}</small>
        ${m.winners ? `<p class="fine">Result: ${esc(m.winners.join(", "))} (${esc(m.resultSource || "")})</p>` : ""}
        ${["settled", "void"].includes(m.status) ? "" : `
        <label>Deadline <input name="lock" type="datetime-local"></label>
        <label>Official winners (team ids${m.kind === "yesno" ? ": yes or no" : ", comma-separated"}) <input name="w"></label>
        <label>Official source (announcement URL) <input name="src"></label>
        <p class="row-actions"><button class="btn small ghost" data-a="lock" type="button">Set deadline</button><button class="btn small ghost" data-a="close" type="button">Close now</button><button class="btn small" data-a="settle" type="button">Settle &amp; reveal</button><button class="btn small ghost" data-a="void" type="button">Void (refund)</button></p>`}
      </form>`,
      )
      .join("")}</section>`;
  const act = (fn) => async () => {
    try {
      msg = "✓ " + ((await fn()) || "Done.");
    } catch (e) {
      msg = e.message;
    }
    render();
  };
  $("#imp").onsubmit = (e) => {
    e.preventDefault();
    const projects = String(new FormData(e.target).get("t")).split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((p) => p[0]).map(([name, team, url, game]) => ({ name, team, url, isGame: /game/i.test(game || "") }));
    act(async () => `Imported ${(await api("/api/royale/mod/projects", { projects })).imported} teams.`)();
  };
  $("#demo-on").onclick = act(async () => (await api("/api/royale/mod/demo", { enabled: true }), "DEMO teams on (clearly labelled in the arena)."));
  $("#demo-off").onclick = act(async () => (await api("/api/royale/mod/demo", { enabled: false }), "DEMO teams removed."));
  for (const f of document.querySelectorAll("form.mk")) {
    const id = f.dataset.id;
    const m = st.markets.find((x) => x.id === id);
    const v = (n) => f.querySelector(`[name=${n}]`)?.value.trim();
    for (const b of f.querySelectorAll("[data-a]"))
      b.onclick = act(async () => {
        const a = b.dataset.a;
        if (a === "lock") return api("/api/royale/mod/markets", { id, mode: m.mode, title: m.title, sponsor: m.sponsor, maxPicks: m.maxPicks, lockAt: new Date(v("lock")).toISOString() }).then(() => "Deadline set.");
        if (a === "close") return api(`/api/royale/mod/markets/${id}/close`, {}).then(() => "Closed.");
        if (a === "void" && !confirm("Void this market and refund every stake?")) return "Cancelled.";
        if (a === "void") return api(`/api/royale/mod/markets/${id}/void`, {}).then(() => "Voided; refunds issued.");
        const winners = v("w").split(",").map((x) => x.trim()).filter(Boolean);
        if (!confirm(`Settle ${m.title} with: ${winners.join(", ")}? This reveals results to everyone and can't be undone.`)) return "Cancelled.";
        return api(`/api/royale/mod/markets/${id}/settle`, { winners, source: v("src") }).then((r) => `Settled. Pool ${r.pool}.`);
      });
  }
}
render();
