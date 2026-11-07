// The plaza's community UI: forum (from the notice board), local chat (T) with speech bubbles,
// and billboard ads (walk up to a hoarding, press E). All live over the world socket.
import * as THREE from "three";
import { authed } from "./identity.js";
import { BOARDS, SLOTS_PER_BOARD, AD_DAYS, AD_RENT_PAISE_PER_DAY, AD_STATUS_LABEL } from "../shared/billboards.js";
import { formatInr } from "../shared/upi.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};
async function api(path, body) {
  const r = await authed(path, body !== undefined ? { method: "POST", body } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error });
  return j;
}

/** Break text into at most `max` lines that fit `width` in the current font. */
function wrap(g, text, width, max) {
  const out = [];
  let line = "";
  for (const w of String(text).split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width <= width || !line) line = next;
    else {
      out.push(line);
      line = w;
      if (out.length === max) break;
    }
  }
  if (out.length < max && line) out.push(line);
  if (out.length === max && out.join(" ").length < String(text).length) out[max - 1] = out[max - 1].replace(/\s*\S*$/, "…");
  return out;
}
function pill(g, x, y, w, h) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, h / 2);
  else g.rect(x, y, w, h);
  g.fill();
}

/**
 * Paint a hoarding face: the ad's image (cover-fit) with a brand pill, headline and up to two
 * lines of description, or the "your ad here" card. `preview` stamps it as visible only to you.
 */
export function paintBoard(canvas, ad, img, { preview = false } = {}) {
  const g = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  g.fillStyle = "#fbf3e4";
  g.fillRect(0, 0, W, H);
  if (ad) {
    g.font = "30px 'Patrick Hand', cursive";
    const lines = ad.text ? wrap(g, ad.text, W - 60, 2) : [];
    const strip = 96 + lines.length * 36;
    if (img) {
      const sc = Math.max(W / img.width, (H - strip) / img.height);
      const w = img.width * sc;
      const h = img.height * sc;
      g.save();
      g.beginPath();
      g.rect(0, 0, W, H - strip);
      g.clip();
      g.drawImage(img, (W - w) / 2, (H - strip - h) / 2, w, h);
      g.restore();
    } else {
      g.fillStyle = "#f3d98b";
      g.fillRect(0, 0, W, H - strip);
      g.fillStyle = "#2b2230";
      g.textAlign = "center";
      g.font = "800 64px 'Bricolage Grotesque', system-ui, sans-serif";
      g.fillText(String(ad.brand || "").slice(0, 30), W / 2, (H - strip) / 2 + 22, W - 80);
    }
    if (ad.brand) {
      g.font = "800 28px 'Bricolage Grotesque', system-ui, sans-serif";
      const bw = Math.min(W - 60, g.measureText(ad.brand).width + 40);
      g.fillStyle = "rgba(43,34,48,.92)";
      pill(g, 22, 22, bw, 48);
      g.fillStyle = "#fbf3e4";
      g.textAlign = "left";
      g.fillText(ad.brand, 42, 56, bw - 40);
    }
    g.fillStyle = "#2b2230";
    g.fillRect(0, H - strip, W, strip);
    g.fillStyle = "#fbf3e4";
    g.textAlign = "left";
    g.font = "800 46px 'Bricolage Grotesque', system-ui, sans-serif";
    g.fillText(ad.title, 28, H - strip + 56, W - 190);
    g.font = "30px 'Patrick Hand', cursive";
    lines.forEach((l, i) => g.fillText(l, 28, H - strip + 98 + i * 36, W - 56));
    g.fillStyle = "#f3d98b";
    g.fillRect(W - 140, H - strip + 20, 116, 42);
    g.fillStyle = "#2b2230";
    g.font = "800 24px 'Bricolage Grotesque', system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(ad.rented ? "SPONSOR" : "AD", W - 82, H - strip + 49);
    if (preview) {
      g.save();
      g.translate(W / 2, (H - strip) / 2);
      g.rotate(-0.12);
      g.fillStyle = "rgba(184,92,74,.88)";
      g.fillRect(-W, -34, W * 2, 68);
      g.fillStyle = "#fbf3e4";
      g.font = "800 34px 'Bricolage Grotesque', system-ui, sans-serif";
      g.fillText("PREVIEW · only you can see this", 0, 12);
      g.restore();
    }
  } else {
    g.fillStyle = "#2b2230";
    g.textAlign = "center";
    g.font = "800 72px 'Bricolage Grotesque', system-ui, sans-serif";
    g.fillText("YOUR AD HERE", W / 2, H / 2 - 10);
    g.font = "38px 'Patrick Hand', cursive";
    g.fillText("walk up and press E · moderated · 1 day free", W / 2, H / 2 + 52);
  }
  g.strokeStyle = "#2b2230";
  g.lineWidth = 12;
  g.strokeRect(6, 6, W - 12, H - 12);
}

/** Resize + re-encode an uploaded image in the browser (max 1024 px; strips EXIF/GPS). */
async function prepareImage(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Choose a PNG, JPEG or WebP image.");
  if (file.size > 12 * 1024 * 1024) throw new Error("That image is too large (12 MB max before resizing).");
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
  if (c.width < 64 || c.height < 64) throw new Error("That image is too small (64 px minimum).");
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.86;
  let url = c.toDataURL("image/jpeg", q);
  while (url.length * 0.75 > 650 * 1024 && q > 0.4) url = c.toDataURL("image/jpeg", (q -= 0.12));
  return url;
}
const loadImg = (src) => new Promise((res) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = () => res(null);
  i.src = src;
});

export function createCommunityUI({ scene, camera, R, mapDir, tangentToward, toon, P, colliders, net, pay, ui, feed, chime, myName, myId, openShop = () => {}, myShop = () => null, canInteract = () => true, onOpenChange = () => {} }) {
  // ---------------------------------------------------------------- the sheet (forum + ads)
  const root = document.createElement("div");
  root.id = "forum";
  root.hidden = true;
  root.innerHTML = `<div class="pay-back"></div><section class="pay-sheet" role="dialog" aria-modal="true" aria-labelledby="fo-h"><div class="pay-body"></div></section>`;
  document.body.append(root);
  const body = root.querySelector(".pay-body");
  root.querySelector(".pay-back").onclick = () => close();
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  });
  let view = null;
  let cat = "general";
  let thread = null;
  const isOpen = () => !root.hidden;
  const show = () => root.hidden && ((root.hidden = false), onOpenChange(true));
  function close() {
    if (root.hidden) return;
    if (root.contains(document.activeElement)) document.activeElement.blur();
    root.hidden = true;
    view = null;
    onOpenChange(false);
  }
  function render(html) {
    body.innerHTML = html;
    (body.querySelector("[autofocus]") || body.querySelector("button, input, textarea"))?.focus({ preventScroll: true });
    body.querySelectorAll("[data-close]").forEach((b) => (b.onclick = close));
  }
  const head = (t, back) => `<header class="pay-head">${back ? `<button class="link" data-back>← ${esc(back)}</button>` : ""}<h2 id="fo-h">${t}</h2><button class="x" data-close aria-label="Close">×</button></header>`;
  const err = (e) => `<p class="err">${esc(e.message || e)}</p>`;
  const report = async (kind, id, b) => {
    b.disabled = true;
    try {
      const r = await api("/api/report", { kind, id });
      b.textContent = r.hidden ? "Hidden for review" : "Reported";
    } catch (e) {
      b.textContent = e.message;
    }
  };

  // ---------------------------------------------------------------- forum
  async function openForum(msg = "") {
    view = "forum";
    thread = null;
    show();
    let d;
    try {
      d = await api(`/api/forum?cat=${cat}`);
    } catch (e) {
      return render(`${head("Community board")}${err(e)}`);
    }
    render(`${head("Community board")}
      <div class="cr-tabs" role="tablist">${Object.entries(d.cats).map(([k, n]) => `<button type="button" role="tab" data-cat="${k}" aria-selected="${k === cat}">${esc(n)}</button>`).join("")}</div>
      ${msg}
      <ul class="hist threads">${d.threads.map((t) => `<li><button class="thread-link" data-thread="${esc(t.id)}"><b>${esc(t.title)}</b><small>${esc(t.authorName)} · ${when(t.lastAt)} · ${t.replies} repl${t.replies === 1 ? "y" : "ies"}</small></button></li>`).join("") || `<li class="muted">No threads here yet. Start one!</li>`}</ul>
      <details class="new-thread"><summary>Start a thread</summary>
        <form class="form" id="thread-f"><label>Title<input name="title" maxlength="80" required minlength="4"></label><label>Message<textarea name="body" maxlength="1500" rows="4" required></textarea></label><button class="btn small">Post</button></form></details>
      <p class="fine">Be kind. Never share seed phrases or private keys: no one in OMEN will ever ask. Posts can be reported; moderators review them.</p>`);
    body.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => ((cat = b.dataset.cat), openForum())));
    body.querySelectorAll("[data-thread]").forEach((b) => (b.onclick = () => openThread(b.dataset.thread)));
    body.querySelector("#thread-f").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        const t = await api("/api/forum", { ...f, cat, name: myName() });
        openThread(t.id);
      } catch (er) {
        openForum(err(er));
      }
    };
  }

  async function openThread(id, msg = "", replyTo = null) {
    view = "thread";
    thread = id;
    show();
    let d;
    try {
      d = await api(`/api/forum/${id}`);
    } catch (e) {
      return openForum(err(e));
    }
    const top = d.posts.filter((p) => !p.parentId);
    const kids = (pid) => d.posts.filter((p) => p.parentId === pid);
    const post = (p, nested) => `<li class="${nested ? "nested" : ""}"><p><b>${esc(p.authorName)}</b> <small class="muted">${when(p.createdAt)}</small></p><p class="post-body">${esc(p.body)}</p>
      <p class="post-acts">${nested ? "" : `<button class="link" data-reply="${esc(p.id)}">Reply</button>`}${p.author !== myId() ? ` <button class="link" data-report="${esc(p.id)}">Report</button>` : ""}</p></li>`;
    render(`${head(esc(d.thread.title), "Board")}
      <article class="op"><p><b>${esc(d.thread.authorName)}</b> <small class="muted">${when(d.thread.createdAt)}</small></p><p class="post-body">${esc(d.thread.body)}</p>
        ${d.thread.author !== myId() ? `<p class="post-acts"><button class="link" data-report-thread>Report</button></p>` : ""}</article>
      <ul class="posts">${top.map((p) => post(p, false) + kids(p.id).map((k) => post(k, true)).join("")).join("") || `<li class="muted">No replies yet.</li>`}</ul>
      ${msg}
      <form class="form" id="reply-f">${replyTo ? `<p class="fine">Replying to <b>${esc(d.posts.find((p) => p.id === replyTo)?.authorName)}</b> · <button type="button" class="link" data-unreply>cancel</button></p>` : ""}
        <label>${replyTo ? "Your reply" : "Add to the thread"}<textarea name="body" maxlength="1000" rows="3" required ${replyTo ? "autofocus" : ""}></textarea></label><button class="btn small">Send</button></form>`);
    body.querySelector("[data-back]").onclick = () => openForum();
    body.querySelectorAll("[data-reply]").forEach((b) => (b.onclick = () => openThread(id, "", b.dataset.reply)));
    body.querySelector("[data-unreply]")?.addEventListener("click", () => openThread(id));
    body.querySelectorAll("[data-report]").forEach((b) => (b.onclick = () => report("post", b.dataset.report, b)));
    body.querySelector("[data-report-thread]")?.addEventListener("click", (e) => report("thread", id, e.target));
    body.querySelector("#reply-f").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/forum/${id}/reply`, { body: new FormData(e.target).get("body"), parentId: replyTo, name: myName() });
        openThread(id);
      } catch (er) {
        openThread(id, err(er), replyTo);
      }
    };
  }

  net.on("forum:thread", (t) => {
    feed(`${t.authorName} started “${t.title}” on the community board`);
    if (view === "forum" && t.cat === cat) openForum();
  });
  net.on("forum:post", (p) => {
    if (view === "thread" && thread === p.threadId && p.author !== myId()) openThread(thread);
  });
  net.on("forum:reply", (r) => {
    chime();
    ui.toast(`${r.from} replied to “${r.title}”`);
  });
  net.on("forum:hidden", () => view === "forum" && openForum());

  // ---------------------------------------------------------------- chat + speech bubbles
  const chatBar = document.createElement("form");
  chatBar.id = "chat-bar";
  chatBar.hidden = true;
  chatBar.innerHTML = `<label class="sr">Say something to couriers nearby</label><input maxlength="160" autocomplete="off" placeholder="Say something… (Enter to send, Esc to cancel)"><button class="btn small">Say</button>`;
  document.body.append(chatBar);
  const chatInput = chatBar.querySelector("input");
  const bubbles = new Map(); // playerId → { el, until }
  function openChat() {
    chatBar.hidden = false;
    onOpenChange(true);
    chatInput.focus();
  }
  function closeChat() {
    if (chatBar.hidden) return;
    chatInput.blur();
    chatBar.hidden = true;
    chatInput.value = "";
    onOpenChange(false);
  }
  chatBar.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") closeChat();
  });
  chatBar.onsubmit = (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return closeChat();
    net.emit("chat", { text }, (r) => {
      if (r?.error) ui.toast(r.error, 4000);
    });
    closeChat();
  };
  function bubble(id, text) {
    let b = bubbles.get(id);
    if (!b) {
      b = { el: Object.assign(document.createElement("div"), { className: "bubble" }) };
      document.body.append(b.el);
      bubbles.set(id, b);
    }
    b.el.textContent = text;
    b.until = performance.now() + 6000;
  }
  net.on("chat", (l) => {
    bubble(l.id, l.text);
    feed(`${l.name}: ${l.text}`);
  });

  // ---------------------------------------------------------------- billboards in the world
  // Each hoarding has its own dressing so they read as distinct places. Geometry is shared between
  // hoardings and kept to a handful of meshes each.
  const G = {
    face: new THREE.PlaneGeometry(4.2, 2.36),
    frame: new THREE.BoxGeometry(4.45, 2.6, 0.14),
    post: new THREE.CylinderGeometry(0.1, 0.12, 2.2, 8),
    mast: new THREE.BoxGeometry(0.16, 4.7, 0.16),
    beam: new THREE.BoxGeometry(4.95, 0.16, 0.2),
    arm: new THREE.BoxGeometry(0.08, 0.08, 0.5),
    lamp: new THREE.BoxGeometry(0.34, 0.14, 0.26),
    pole: new THREE.CylinderGeometry(0.09, 0.11, 4.9, 8),
    line: new THREE.CylinderGeometry(0.015, 0.015, 4.7, 4),
    plinth: new THREE.BoxGeometry(4.9, 0.8, 0.9),
    pillar: new THREE.BoxGeometry(0.46, 3.7, 0.5),
    cap: new THREE.BoxGeometry(5.5, 0.3, 0.8),
  };
  const flags = (() => {
    // One mesh for the whole string of bunting (vertex colours), sagging between the poles.
    const cols = [P.brick, P.butter, P.teal, P.petal, P.slate].map((c) => new THREE.Color(c));
    const pos = [];
    const col = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const x0 = -2.3 + 4.6 * t0;
      const x1 = x0 + 4.6 / n - 0.06;
      const sag = (t) => -0.28 * Math.sin(Math.PI * t);
      const y0 = 4.75 + sag(t0);
      const y1 = 4.75 + sag(t0 + 1 / n);
      pos.push(x0, y0, 0.02, x1, y1, 0.02, (x0 + x1) / 2, (y0 + y1) / 2 - 0.4, 0.02);
      const c = cols[i % cols.length];
      for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  })();
  const mesh = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };
  function dress(style, g) {
    if (style === "gantry") {
      // steel gantry with three lamps leaning over the face
      const steel = toon(P.slate);
      for (const x of [-2.4, 2.4]) g.add(mesh(G.mast, steel, x, 2.35, -0.05));
      g.add(mesh(G.beam, steel, 0, 4.62, 0.05));
      for (const x of [-1.4, 0, 1.4]) {
        g.add(mesh(G.arm, steel, x, 4.55, 0.3));
        g.add(mesh(G.lamp, toon(P.glow, P.glow, 0.9), x, 4.45, 0.55));
      }
      return toon(P.ink);
    }
    if (style === "bunting") {
      const wood = toon(P.wood);
      for (const x of [-2.35, 2.35]) g.add(mesh(G.pole, wood, x, 2.45, -0.05));
      const line = mesh(G.line, toon(P.ink), 0, 4.68, 0.02);
      line.rotation.z = Math.PI / 2;
      g.add(line, flags.clone());
      return toon(P.teal);
    }
    if (style === "stone") {
      const stone = toon(P.stone);
      g.add(mesh(G.plinth, toon(P.stoneDark), 0, 0.4, -0.1));
      for (const x of [-2.45, 2.45]) g.add(mesh(G.pillar, stone, x, 2.65, -0.1));
      g.add(mesh(G.cap, stone, 0, 4.55, -0.1));
      return toon(P.stoneDark);
    }
    for (const x of [-1.6, 1.6]) g.add(mesh(G.post, toon(P.wood), x, 1.0, -0.05)); // classic: wooden posts
    return toon(P.wood);
  }

  let live = [];
  const boards = BOARDS.map((b) => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1024, height: 576 });
    paintBoard(canvas, null);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const g = new THREE.Group();
    const face = new THREE.Mesh(G.face, new THREE.MeshBasicMaterial({ map: tex }));
    face.position.set(0, 3.0, 0.08);
    face.userData.boardId = b.id;
    const frame = mesh(G.frame, dress(b.style, g), 0, 3.0, 0);
    g.add(face, frame);
    const dir = mapDir(b.at[0], b.at[1]);
    const fwd = tangentToward(dir, mapDir(b.face[0], b.face[1]));
    g.position.copy(dir).multiplyScalar(R);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(dir, fwd), dir, fwd));
    scene.add(g);
    colliders.push({ dir: dir.clone(), r: 1.9 });
    return {
      ...b,
      canvas,
      tex,
      face,
      group: g,
      ads: [],
      i: 0,
      shown: null,
      preview: null,
      center: () => g.localToWorld(new THREE.Vector3(0, 3.0, 0)),
      normal: () => fwd.clone(),
      front: () => g.localToWorld(new THREE.Vector3(0, 0, 2.2)),
      top: () => g.localToWorld(new THREE.Vector3(0, 4.6, 0)),
    };
  });
  const imgCache = new Map();
  const imageFor = (src) => {
    if (!src) return Promise.resolve(null);
    if (!imgCache.has(src)) imgCache.set(src, loadImg(src));
    return imgCache.get(src);
  };
  async function showAd(board, ad) {
    board.shown = ad;
    if (board.preview) return; // the local preview stays until it ends
    const img = await imageFor(ad?.image);
    if (board.shown !== ad || board.preview) return; // rotated on meanwhile
    paintBoard(board.canvas, ad, img);
    board.tex.needsUpdate = true;
  }
  function setLive(ads) {
    live = ads;
    for (const b of boards) {
      b.ads = ads.filter((a) => a.boardId === b.id);
      b.i = 0;
      showAd(b, b.ads[0] || null);
    }
  }
  setInterval(() => {
    for (const b of boards) if (b.ads.length > 1) showAd(b, b.ads[(b.i = (b.i + 1) % b.ads.length)]);
  }, 12_000);
  net.on("ads:update", setLive);
  net.on("ad:update", (a) => {
    const where = BOARDS.find((b) => b.id === a.boardId)?.label;
    const say = { live: `Your ad “${a.title}” is live on the ${where}!`, awaiting_rent: `Your ad “${a.title}” was approved. Confirm the DEMO rental to put it up.`, rejected: `Your ad “${a.title}” wasn't approved${a.reason ? `: ${a.reason}` : "."}`, removed: `A moderator took down “${a.title}”${a.reason ? `: ${a.reason}` : "."}`, expired: `Your ad “${a.title}” has ended.` }[a.status];
    if (say) {
      chime();
      ui.toast(say, 6000);
    }
    if (isOpen() && view === "board") openBoard(openBoard.current);
  });
  const refreshAds = () => api("/api/ads").then((d) => setLive(d.ads)).catch(() => {});

  // ---- the local 3D preview: paint the draft onto the real hoarding for this player only
  let previewTimer = 0;
  async function previewOn(board, draft, imgSrc) {
    clearTimeout(previewTimer);
    board.preview = draft;
    paintBoard(board.canvas, draft, await imageFor(imgSrc), { preview: true });
    board.tex.needsUpdate = true;
    previewTimer = setTimeout(() => endPreview(board), 15_000);
  }
  function endPreview(board) {
    if (!board?.preview) return;
    clearTimeout(previewTimer);
    board.preview = null;
    showAd(board, board.shown);
  }

  // ---- genuine impressions: the face is on screen, facing you, within 24 m, for 1.5 s
  const reported = new Map(); // adId → last report time (the server dedupes too)
  const onScreen = new Map(); // boardId → { adId, since }
  const v = new THREE.Vector3();
  setInterval(() => {
    if (document.visibilityState !== "visible" || !net.id) return;
    const t = performance.now();
    for (const b of boards) {
      const ad = b.shown;
      if (!ad || b.preview) {
        onScreen.delete(b.id);
        continue;
      }
      const c = b.center();
      const toCam = camera.position.clone().sub(c);
      const visible = toCam.length() < 24 && toCam.normalize().dot(b.normal()) > 0.15 && (v.copy(c).project(camera), v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95);
      const was = onScreen.get(b.id);
      if (!visible) {
        onScreen.delete(b.id);
        continue;
      }
      if (!was || was.adId !== ad.id) onScreen.set(b.id, { adId: ad.id, since: t });
      else if (t - was.since >= 1500 && t - (reported.get(ad.id) || -1e9) > 5 * 60_000) {
        reported.set(ad.id, t);
        api(`/api/ads/${ad.id}/seen`, {}).catch(() => {});
      }
    }
  }, 500);
  const click = (ad, kind) => ad && api(`/api/ads/${ad.id}/click`, { kind }).catch(() => {});

  // ---- click (or tap) a hoarding to open it
  const sceneEl = document.getElementById("scene");
  const ray = new THREE.Raycaster();
  let down = null;
  sceneEl?.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
  sceneEl?.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 450 || !canInteract()) return;
    const r = sceneEl.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    ray.far = 30;
    const hit = ray.intersectObjects(boards.map((b) => b.face), false)[0];
    if (hit) openBoard(hit.object.userData.boardId);
  });

  // ---- the hoarding sheet: the ad, its destination, slot availability, the form, your campaigns
  const label = (id) => BOARDS.find((x) => x.id === id)?.label || id;
  const until = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  let draft = null; // { boardId, brand, title, text, dest, link, days, image } survives preview round-trips
  async function openBoard(boardId, msg = "") {
    view = "board";
    openBoard.current = boardId;
    show();
    const b = boards.find((x) => x.id === boardId);
    endPreview(b);
    const ad = b.shown;
    if (ad && !msg) click(ad, "details");
    let mine = [];
    let slots = null;
    try {
      [mine, slots] = await Promise.all([api("/api/ads/mine").then((d) => d.ads), api("/api/ads/boards").then((d) => d.boards.find((x) => x.id === boardId))]);
    } catch {
      /* not joined yet */
    }
    const shop = myShop();
    const d = draft?.boardId === boardId ? draft : { boardId, brand: shop?.name || "", title: "", text: "", dest: shop ? "shop" : "none", link: "", days: "1", image: null };
    const others = b.ads.filter((x) => x !== ad);
    const full = slots && slots.free === 0;
    render(`${head(esc(b.label))}
      ${ad ? `<article class="ad-card"><p class="ad-kicker">${ad.rented ? "Sponsored" : "Advertisement"} · ${esc(ad.brand)} <small class="muted">· posted by ${esc(ad.authorName)}</small></p><h3>${esc(ad.title)}</h3>${ad.text ? `<p>${esc(ad.text)}</p>` : ""}
        ${ad.shop ? `<p><button class="btn small" data-visit="${esc(ad.shop.id)}">Visit ${esc(ad.shop.name)} in the market</button></p>` : ""}
        ${ad.link ? `<p><a href="${esc(ad.link)}" target="_blank" rel="noopener noreferrer nofollow" data-ext>${esc(new URL(ad.link).hostname)} ↗</a> <small class="muted">(leaves OMEN)</small></p>` : ""}
        <p class="post-acts"><button class="link" data-report-ad="${esc(ad.id)}">Report this ad</button></p></article>` : `<p>This hoarding is free. Put your stall, your project or a friendly message in front of every courier who walks past.</p>`}
      ${others.length ? `<p class="fine">Also on this hoarding: ${others.map((x) => `<b>${esc(x.brand)}</b> · ${esc(x.title)}`).join(" · ")}</p>` : ""}
      ${slots ? `<p class="slots ${full ? "full" : ""}" data-slots>${full ? `Fully booked: ${slots.slots} of ${slots.slots} slots taken${slots.nextFreeAt ? `, next one frees ${esc(until(slots.nextFreeAt))}` : ""}.` : `${slots.free} of ${slots.slots} ad slot${slots.slots > 1 ? "s" : ""} free here`}${slots.waiting ? ` · ${slots.waiting} waiting for review` : ""}</p>` : ""}
      ${msg}
      <details ${ad || full ? "" : "open"}><summary>${full ? "Book this hoarding (fully booked now)" : "Claim a slot on this hoarding"}</summary>
        <form class="form" id="ad-f">
          <label>Brand name<input name="brand" maxlength="30" required minlength="2" value="${esc(d.brand)}"></label>
          <label>Headline<input name="title" maxlength="40" required minlength="2" value="${esc(d.title)}"></label>
          <label>Description <small class="muted">(up to 160 characters)</small><textarea name="text" maxlength="160" rows="2">${esc(d.text)}</textarea></label>
          <fieldset><legend>When someone clicks it</legend>
            <label><input type="radio" name="dest" value="none" ${d.dest === "none" ? "checked" : ""}> Just show the details</label>
            <label><input type="radio" name="dest" value="shop" ${d.dest === "shop" ? "checked" : ""} ${shop ? "" : "disabled"}> Open my market stall ${shop ? `(<b>${esc(shop.name)}</b>)` : `<small class="muted">(claim a stall first)</small>`}</label>
            <label><input type="radio" name="dest" value="link" ${d.dest === "link" ? "checked" : ""}> A website <small class="muted">(https only; a moderator checks it)</small></label>
            <input name="link" type="url" placeholder="https://" maxlength="200" value="${esc(d.link)}" aria-label="Website address">
          </fieldset>
          <label>Image <small class="muted">(PNG, JPEG or WebP; resized and stripped of location data in your browser)</small><input type="file" name="file" accept="image/png,image/jpeg,image/webp"></label>
          <fieldset><legend>Run it for</legend>${AD_DAYS.map((n) => `<label><input type="radio" name="days" value="${n}" ${String(n) === String(d.days) ? "checked" : ""}> ${n} day${n > 1 ? "s" : ""} · ${n === 1 ? "free" : `${formatInr(n * AD_RENT_PAISE_PER_DAY)} in DEMO credits (play money; testnet USDT optional), after approval`}</label>`).join("")}</fieldset>
          <canvas id="ad-preview" width="1024" height="576" class="ad-preview" aria-label="Preview of your ad"></canvas>
          <div class="row-actions"><button type="button" class="btn small ghost" data-preview3d>Preview on the hoarding</button><button class="btn small" data-submit ${full ? "disabled" : ""}>Submit for review</button></div>
          <p class="fine">A moderator approves every ad (and its link) before anyone sees it. No scams, no hate, nothing you don't have the rights to. Billboard rental here is DEMO only: no real money moves.</p>
        </form></details>
      ${mine.length ? `<h3>Your campaigns</h3><ul class="hist campaigns">${mine.map((a) => `<li data-campaign="${esc(a.id)}"><div><b>${esc(a.brand)} · ${esc(a.title)}</b>
          <small>${esc(label(a.boardId))} · ${a.days} day${a.days > 1 ? "s" : ""} · <span class="cstatus ${esc(a.status)}">${esc(AD_STATUS_LABEL[a.status] || a.status)}</span>${a.status === "live" && a.expiresAt ? ` until ${esc(until(a.expiresAt))}` : ""}${a.reason ? ` · “${esc(a.reason)}”` : ""}</small>
          <small class="stats" data-stats><b>${a.stats.impressions}</b> impressions · <b>${a.stats.uniqueViewers}</b> unique viewers · <b>${a.stats.clicks}</b> clicks · ${a.stats.ctr}% of viewers clicked</small></div>
        ${a.status === "awaiting_rent" ? `<span><button class="btn small" data-rent="${esc(a.id)}" data-tok="DEMO">Confirm DEMO rental</button> <button class="btn small ghost" data-rent="${esc(a.id)}" data-tok="USDT">Pay testnet USDT</button></span>` : ""}</li>`).join("")}</ul>
        <p class="fine">Impressions count real players who had this hoarding on screen, facing them, for 1.5 s (once per player per 5 minutes; your own views don't count). Clicks count players opening the ad or its destination.</p>` : ""}`);
    const form = body.querySelector("#ad-f");
    const preview = body.querySelector("#ad-preview");
    let image = d.image;
    let imgEl = null;
    if (image) loadImg(image).then((i) => ((imgEl = i), draw())); // don't block wiring the form
    const read = () => {
      const f = Object.fromEntries(new FormData(form));
      return { boardId, brand: (f.brand || "").trim(), title: (f.title || "").trim(), text: (f.text || "").trim(), dest: f.dest || "none", link: (form.querySelector("[name=link]").value || "").trim(), days: f.days, image };
    };
    const draw = () => {
      const f = read();
      draft = f;
      form.querySelector("[name=link]").disabled = f.dest !== "link";
      paintBoard(preview, { brand: f.brand || "Your brand", title: f.title || "Your headline", text: f.text, rented: Number(f.days) > 1 }, imgEl);
    };
    draw();
    form.addEventListener("input", draw);
    form.querySelector("[name=file]").onchange = async (e) => {
      try {
        image = e.target.files[0] ? await prepareImage(e.target.files[0]) : null;
        imgEl = image ? await loadImg(image) : null;
        draw();
      } catch (er) {
        e.target.value = "";
        ui.toast(er.message, 4000);
      }
    };
    body.querySelector("[data-preview3d]").onclick = () => {
      const f = read();
      draft = f;
      close();
      previewOn(b, { brand: f.brand || "Your brand", title: f.title || "Your headline", text: f.text, rented: Number(f.days) > 1 }, image);
      ui.toast("Previewing on the hoarding (only you can see it). Press E here again to keep editing.", 5000);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = read();
      const btn = form.querySelector("[data-submit]");
      btn.disabled = true;
      btn.textContent = "Uploading…";
      try {
        await api("/api/ads", { boardId, brand: f.brand, title: f.title, text: f.text, shopId: f.dest === "shop" ? shop?.id : null, link: f.dest === "link" ? f.link : null, days: Number(f.days), image, name: myName() });
        draft = null;
        openBoard(boardId, `<p class="ok">Submitted! A moderator will review it; you'll get a note here when it's decided.</p>`);
      } catch (er) {
        openBoard(boardId, err(er));
      }
    };
    body.querySelector("[data-report-ad]")?.addEventListener("click", (e) => report("ad", ad.id, e.target));
    body.querySelector("[data-visit]")?.addEventListener("click", () => {
      click(ad, "shop");
      close();
      openShop(ad.shop.id);
    });
    body.querySelector("[data-ext]")?.addEventListener("click", (e) => {
      if (!confirm(`This link leaves OMEN for ${new URL(ad.link).hostname}. Never enter a seed phrase or private key anywhere. Continue?`)) e.preventDefault();
      else click(ad, "link");
    });
    body.querySelectorAll("[data-rent]").forEach(
      (btn) =>
        (btn.onclick = async () => {
          btn.disabled = true;
          try {
            const { payment } = await api(`/api/ads/${btn.dataset.rent}/rent`, { token: btn.dataset.tok });
            close();
            pay.checkoutPayment(payment);
          } catch (er) {
            openBoard(boardId, err(er));
          }
        }),
    );
  }

  /** Per frame: speech bubbles follow heads. */
  function update(heads) {
    const now = performance.now();
    for (const [id, b] of bubbles) {
      const head = heads(id);
      if (!head || now > b.until) {
        b.el.hidden = true;
        continue;
      }
      const v = head.clone().project(camera);
      b.el.hidden = v.z > 1;
      b.el.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
    }
  }

  return { openForum, openThread, openBoard, openChat, closeChat, refreshAds, boards, update, isOpen: () => isOpen() || !chatBar.hidden, get live() {
      return live;
    } };
}
