// Moderation console: approve/reject billboard ads, review reported posts and ads, mute couriers.
import "./merchant.css";
import { BOARDS } from "../shared/billboards.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let key = "";
const status = (t, cls = "") => {
  $("#m-status").className = `status ${cls}`;
  $("#m-status span:last-child").textContent = t;
};
async function call(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "x-mod-key": key, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
        (a) => `<li><span class="time">${esc(BOARDS.find((b) => b.id === a.boardId)?.label || a.boardId)}</span>
        <span class="what"><b>${esc(a.title)}</b> <span class="badge demo">${a.days} day${a.days > 1 ? "s" : ""}${a.days > 1 ? " · rental" : " · free"}</span>
          <small>${esc(a.text)} · by ${esc(a.authorName)}${a.link ? ` · link: <code>${esc(a.link)}</code>` : ""}</small>
          ${a.image ? `<img src="${esc(a.image)}" alt="Ad image" class="mod-img">` : `<small>(no image)</small>`}</span>
        <span class="amt"><button class="btn small" data-act="approve" data-id="${esc(a.id)}">Approve</button><br><button class="btn small ghost" data-act="reject" data-id="${esc(a.id)}">Reject</button><br><button class="link" data-mute="${esc(a.author)}">Mute author</button></span></li>`,
      )
      .join("") || `<li class="empty">Nothing waiting.</li>`;
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
        const reason = b.dataset.act === "reject" ? prompt("Reason (shown to the author)?", "Doesn't follow the billboard rules") : "";
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
