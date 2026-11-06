// Moderation console: approve/reject billboard ads, review reported posts and ads, mute couriers.
import "./merchant.css";
import { BOARDS, AD_STATUS_LABEL } from "../shared/billboards.js";

// If this browser also plays OMEN, send its player identity so the server can refuse to let a
// moderator approve or reject their own ad. Read only: this page never creates an identity.
let player = "";
try {
  const t = localStorage.getItem("omen.identity") || "";
  if (/^[a-f0-9]{64}$/.test(t)) player = t;
} catch {
  /* ignore */
}
const boardLabel = (id) => BOARDS.find((b) => b.id === id)?.label || id;
const dest = (a) => (a.shop ? `opens stall “${esc(a.shop.name)}”` : a.link ? `link: <code>${esc(a.link)}</code>` : "no destination");
const stats = (s) => `${s.impressions} impressions · ${s.uniqueViewers} unique viewers · ${s.clicks} clicks · ${s.ctr}% of viewers clicked`;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let key = "";
const status = (t, cls = "") => {
  $("#m-status").className = `status ${cls}`;
  $("#m-status span:last-child").textContent = t;
};
async function call(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "x-mod-key": key, ...(player ? { "x-omen-token": player } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`);
  return j;
}

async function load() {
  let q;
  try {
    q = await call("/api/mod/queue");
  } catch (e) {
    status(e.message, "off");
    return false;
  }
  status(`${q.pendingAds.length} ad${q.pendingAds.length === 1 ? "" : "s"} waiting · ${q.reported.length} reported`, "on");
  $("#ads").innerHTML =
    q.pendingAds
      .map(
        (a) => `<li data-pending="${esc(a.id)}"><span class="time">${esc(boardLabel(a.boardId))}<br><small>${a.board ? `${a.board.free}/${a.board.slots} slots free` : ""}</small></span>
        <span class="what"><b>${esc(a.brand)} · ${esc(a.title)}</b> <span class="badge demo">${a.days} day${a.days > 1 ? "s" : ""}${a.days > 1 ? " · DEMO rental" : " · free"}</span>
          <small>${esc(a.text)} · by ${esc(a.authorName)} · ${dest(a)}</small>
          ${a.image ? `<img src="${esc(a.image)}" alt="Ad image" class="mod-img">` : `<small>(no image)</small>`}</span>
        <span class="amt"><button class="btn small" data-act="approve" data-id="${esc(a.id)}">Approve</button><br><button class="btn small ghost" data-act="reject" data-id="${esc(a.id)}">Reject</button><br><button class="link" data-mute="${esc(a.author)}">Mute author</button></span></li>`,
      )
      .join("") || `<li class="empty">Nothing waiting.</li>`;
  $("#live").innerHTML =
    q.liveAds
      .map(
        (a) => `<li data-live="${esc(a.id)}"><span class="time">${esc(boardLabel(a.boardId))}<br><small>until ${new Date(a.expiresAt).toLocaleString()}</small></span>
        <span class="what"><b>${esc(a.brand)} · ${esc(a.title)}</b> <span class="state COMPLETED">live</span><small>${dest(a)} · by ${esc(a.authorName)}</small><small>${stats(a.stats)}</small></span>
        <span class="amt"><button class="btn small ghost" data-act="takedown" data-id="${esc(a.id)}">Take down</button></span></li>`,
      )
      .join("") || `<li class="empty">No ads running.</li>`;
  $("#decided").innerHTML =
    q.decided
      .map((a) => `<li><span class="time">${esc(boardLabel(a.boardId))}</span><span class="what"><b>${esc(a.brand)} · ${esc(a.title)}</b> <span class="state ${a.status === "expired" ? "COMPLETED" : "FAILED"}">${esc(AD_STATUS_LABEL[a.status] || a.status)}</span><small>${a.reason ? `“${esc(a.reason)}” · ` : ""}${stats(a.stats)}</small></span><span class="amt"></span></li>`)
      .join("") || `<li class="empty">Nothing yet.</li>`;
  $("#reports").innerHTML =
    q.reported
      .map(
        (x) => `<li><span class="time">${esc(x.kind)}</span><span class="what"><b>${x.reports} report${x.reports > 1 ? "s" : ""}</b> ${x.hidden ? `<span class="state FAILED">hidden</span>` : `<span class="state COMPLETED">visible</span>`}
          <small>${esc(x.text)} · by ${esc(x.authorName)}</small>${x.image ? `<img src="${esc(x.image)}" alt="" class="mod-img">` : ""}</span>
        <span class="amt">${x.hidden ? `<button class="btn small" data-act="unhide" data-kind="${x.kind}" data-id="${esc(x.id)}">Restore</button>` : `<button class="btn small" data-act="hide" data-kind="${x.kind}" data-id="${esc(x.id)}">Hide</button>`}<br>
          <button class="btn small ghost" data-act="delete" data-kind="${x.kind}" data-id="${esc(x.id)}">Delete</button><br><button class="link" data-mute="${esc(x.author)}">Mute author</button></span></li>`,
      )
      .join("") || `<li class="empty">No reports.</li>`;
  $("#muted").innerHTML = q.muted.map((m) => `<li><span class="time">${new Date(m.at).toLocaleDateString()}</span><span class="what"><code>${esc(m.id)}</code><small>${esc(m.reason || "")}</small></span><span class="amt"><button class="btn small ghost" data-unmute="${esc(m.id)}">Unmute</button></span></li>`).join("") || `<li class="empty">Nobody is muted.</li>`;
  document.querySelectorAll("[data-act]").forEach(
    (b) =>
      (b.onclick = async () => {
        const reason = b.dataset.act === "reject" ? prompt("Reason (shown to the author)?", "Doesn't follow the billboard rules") : b.dataset.act === "takedown" ? prompt("Why take it down? (shown to the author)", "Breaks the billboard rules") : "";
        if (reason === null) return;
        b.disabled = true;
        try {
          await call("/api/mod", { action: b.dataset.act, kind: b.dataset.kind, id: b.dataset.id, reason });
        } catch (e) {
          alert(e.message);
        }
        load();
      }),
  );
  document.querySelectorAll("[data-mute]").forEach(
    (b) =>
      (b.onclick = async () => {
        const reason = prompt("Why mute this courier?", "spam");
        if (reason === null) return;
        await call("/api/mod", { action: "mute", playerId: b.dataset.mute, reason }).catch((e) => alert(e.message));
        load();
      }),
  );
  document.querySelectorAll("[data-unmute]").forEach((b) => (b.onclick = async () => (await call("/api/mod", { action: "unmute", playerId: b.dataset.unmute }).catch((e) => alert(e.message)), load())));
  return true;
}

$("#unlock").onsubmit = async (e) => {
  e.preventDefault();
  key = $("#key").value;
  if (await load()) {
    try {
      sessionStorage.setItem("omen.modkey", key);
    } catch {
      /* ignore */
    }
    $("#unlock").hidden = true;
    $("#board").hidden = false;
    setInterval(load, 10_000);
  }
};
try {
  key = sessionStorage.getItem("omen.modkey") || "";
} catch {
  /* ignore */
}
if (key) $("#key").value = key;
