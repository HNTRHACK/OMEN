// Wayfinding: a minimap (always on), a full map (M) and quick-travel buttons for every pavilion.
import * as L from "./layout.js";

const hex = (c) => `#${c.toString(16).padStart(6, "0")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Paint the floor plan into a 2D context fitted to (w, h). Returns the world→canvas mapping. */
function plan(g, w, h, pad) {
  const { x0, x1, z0, z1 } = L.BOUNDS;
  const s = Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (z1 - z0));
  const ox = (w - (x1 - x0) * s) / 2;
  const oz = (h - (z1 - z0) * s) / 2;
  const P = (x, z) => [ox + (x - x0) * s, oz + (z - z0) * s];
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#f1e6d2";
  g.fillRect(...P(x0, 0), (x1 - x0) * s, L.CONCOURSE_D * s);
  for (const p of L.PAVILIONS) {
    g.fillStyle = hex(p.color) + (p.open ? "55" : "26");
    g.fillRect(...P(p.x0, z0), p.w * s, L.HALL_D * s);
    g.fillStyle = hex(p.color);
    g.font = `800 ${Math.max(11, Math.round(s * 7))}px 'Bricolage Grotesque', system-ui, sans-serif`;
    g.textAlign = "center";
    const [tx, tz] = P(p.cx, -L.HALL_D / 2);
    g.fillText(String(p.id), tx, tz + 4);
  }
  g.fillStyle = "#2b2230";
  for (const b of L.wallBoxes()) {
    const [ax, az] = P(b.x0, b.z0);
    g.fillRect(ax, az, Math.max(1.5, (b.x1 - b.x0) * s), Math.max(1.5, (b.z1 - b.z0) * s));
  }
  g.fillStyle = "#9e9384";
  for (const c of L.COLUMNS) {
    const [px, pz] = P(c.x, c.z);
    g.beginPath();
    g.arc(px, pz, Math.max(1.5, s * 1.2), 0, Math.PI * 2);
    g.fill();
  }
  // the Main Stage deck
  g.fillStyle = "#1f1c25";
  const [sx, sz] = P(L.STAGE.x0, L.STAGE.z0);
  g.fillRect(sx, sz, (L.STAGE.x1 - L.STAGE.x0) * s, (L.STAGE.z1 - L.STAGE.z0) * s);
  g.fillStyle = "#6d6458";
  for (const b of L.propBoxes()) {
    const [ax, az] = P(b.x0, b.z0);
    g.fillRect(ax, az, Math.max(2, (b.x1 - b.x0) * s), Math.max(2, (b.z1 - b.z0) * s));
  }
  return P;
}

export function createMap({ getPlayer, getRemotes, onTravel }) {
  const hud = document.createElement("div");
  hud.id = "expo-nav";
  hud.innerHTML = `
    <canvas id="minimap" width="300" height="140" aria-label="Map of the OMEN Expo. Click to open the full map." role="button" tabindex="0"></canvas>
    <p id="where" aria-live="polite"></p>
    <nav class="travel" aria-label="Quick travel">${L.PLACES.map((p, i) => `<button class="btn small ${p.key === "p1" ? "" : "ghost"}" data-go="${p.key}" title="${esc(p.label)}"><b>${p.key === "concourse" ? "⌂" : p.key.slice(1)}</b> ${esc(p.key === "concourse" ? "Arrival" : ["Stage", "Ads & Expo", "Lounge"][i - 1])}</button>`).join("")}</nav>`;
  document.body.append(hud);
  const full = document.createElement("div");
  full.id = "expo-map";
  full.hidden = true;
  full.innerHTML = `<div class="map-card" role="dialog" aria-modal="true" aria-labelledby="map-h">
      <header><h2 id="map-h">OMEN · Mumbai venue map</h2><button class="x" data-close aria-label="Close map">×</button></header>
      <canvas id="bigmap" width="1100" height="520"></canvas>
      <ul class="map-legend">${L.PAVILIONS.map((p) => `<li><span class="sw" style="background:${hex(p.color)}"></span><div><b>${esc(p.name)} · ${esc(p.theme)}</b> ${p.open ? `<span class="badge real">open</span>` : `<span class="badge sim">opening soon</span>`}<small>${esc(p.blurb)}</small></div><button class="btn small" data-go="p${p.id}">Go</button></li>`).join("")}
        <li><span class="sw" style="background:#f1e6d2"></span><div><b>Arrival hall</b><small>Arrival under the white arch, LED screens, and the doorway back to Blockhaven village (east end).</small></div><button class="btn small" data-go="concourse">Go</button></li></ul>
      <p class="fine">A stylised venue inspired by the exhibition halls of the Jio World Convention Centre (three pavilions, 12 m ceilings, branching columns). Zone placement is OMEN's own; it is not an official venue or event floor plan.</p>
    </div>`;
  document.body.append(full);

  const mini = hud.querySelector("#minimap");
  const big = full.querySelector("#bigmap");
  const base = document.createElement("canvas");
  base.width = mini.width;
  base.height = mini.height;
  const P = plan(base.getContext("2d"), base.width, base.height, 6);
  const bigBase = document.createElement("canvas");
  bigBase.width = big.width;
  bigBase.height = big.height;
  const BP = plan(bigBase.getContext("2d"), big.width, big.height, 16);

  const open = () => {
    full.hidden = false;
    draw(true);
    full.querySelector("[data-close]").focus();
  };
  const close = () => (full.hidden = true);
  mini.onclick = open;
  mini.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open());
  full.querySelector("[data-close]").onclick = close;
  full.addEventListener("click", (e) => e.target === full && close());
  full.addEventListener("keydown", (e) => (e.stopPropagation(), e.key === "Escape" && close()));
  for (const b of document.querySelectorAll("#expo-nav [data-go], #expo-map [data-go]"))
    b.onclick = () => {
      close();
      onTravel(b.dataset.go);
      b.blur();
    };

  function dot(g, Pm, x, z, r, fill) {
    const [px, pz] = Pm(x, z);
    g.fillStyle = fill;
    g.beginPath();
    g.arc(px, pz, r, 0, Math.PI * 2);
    g.fill();
  }
  function draw(isBig = false) {
    const [cv, src, Pm, r] = isBig ? [big, bigBase, BP, 7] : [mini, base, P, 3.5];
    const g = cv.getContext("2d");
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(src, 0, 0);
    for (const o of getRemotes()) dot(g, Pm, o.x, o.z, r * 0.8, "#5f7d99");
    const me = getPlayer();
    const [px, pz] = Pm(me.x, me.z);
    g.save();
    g.translate(px, pz);
    g.rotate(-me.yaw + Math.PI);
    g.fillStyle = "#c8473d";
    g.strokeStyle = "#fbf3e4";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -r * 2.2);
    g.lineTo(r * 1.4, r * 1.4);
    g.lineTo(-r * 1.4, r * 1.4);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
  let acc = 0;
  let lastZone = null;
  return {
    get isOpen() {
      return !full.hidden;
    },
    open,
    close,
    toggle: () => (full.hidden ? open() : close()),
    update(dt) {
      acc += dt;
      if (acc < 0.1) return; // 10 Hz is plenty for a map
      acc = 0;
      draw(false);
      if (!full.hidden) draw(true);
      const me = getPlayer();
      const z = L.zoneAt(me.x, me.z);
      if (z !== lastZone) {
        lastZone = z;
        const p = L.PAVILIONS.find((x) => x.id === z);
        hud.querySelector("#where").textContent = z === 0 ? "Arrival hall" : p ? `${p.name} · ${p.theme}${p.open ? "" : " (opening soon)"}` : "";
        hud.querySelectorAll(".travel [data-go]").forEach((b) => b.classList.toggle("here", b.dataset.go === (z === 0 ? "concourse" : `p${z}`)));
      }
    },
  };
}
