// The plaza's community UI: forum (from the notice board), local chat (T) with speech bubbles,
// and billboard ads (walk up to a hoarding, press E). All live over the world socket.
import * as THREE from "three";
import { authed } from "./identity.js";
import { BOARDS, AD_DAYS, AD_RENT_PAISE_PER_DAY } from "../shared/billboards.js";
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

/** Paint a billboard face: the ad's image (cover-fit) with its title strip, or the "your ad here" card. */
export function paintBoard(canvas, ad, img) {
  const g = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  g.fillStyle = "#fbf3e4";
  g.fillRect(0, 0, W, H);
  if (ad) {
    const strip = ad.text ? 128 : 92;
    if (img) {
      const s = Math.max(W / img.width, (H - strip) / img.height);
      const w = img.width * s;
      const h = img.height * s;
      g.save();
      g.beginPath();
      g.rect(0, 0, W, H - strip);
      g.clip();
      g.drawImage(img, (W - w) / 2, (H - strip - h) / 2, w, h);
      g.restore();
    } else {
      g.fillStyle = "#f3d98b";
      g.fillRect(0, 0, W, H - strip);
    }
    g.fillStyle = "#2b2230";
    g.fillRect(0, H - strip, W, strip);
    g.fillStyle = "#fbf3e4";
    g.textAlign = "left";
    g.font = "800 46px 'Bricolage Grotesque', system-ui, sans-serif";
    g.fillText(ad.title, 24, H - strip + 54, W - 160);
    if (ad.text) {
      g.font = "30px 'Patrick Hand', cursive";
      g.fillText(ad.text, 24, H - strip + 100, W - 48);
    }
    g.fillStyle = "#f3d98b";
    g.fillRect(W - 120, H - strip + 18, 100, 40);
    g.fillStyle = "#2b2230";
    g.font = "800 24px 'Bricolage Grotesque', system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(ad.rented ? "SPONSOR" : "AD", W - 70, H - strip + 46);
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

export function createCommunityUI({ scene, camera, R, mapDir, tangentToward, toon, P, colliders, net, pay, ui, feed, chime, myName, myId, onOpenChange = () => {} }) {
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
  let live = [];
  const boards = BOARDS.map((b) => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1024, height: 576 });
    paintBoard(canvas, null);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const g = new THREE.Group();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.36), new THREE.MeshBasicMaterial({ map: tex }));
    face.position.set(0, 3.0, 0.08);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(4.45, 2.6, 0.14), toon(P.wood));
    frame.position.set(0, 3.0, 0);
    g.add(face, frame);
    for (const x of [-1.6, 1.6]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.2, 8), toon(P.wood));
      post.position.set(x, 1.0, -0.05);
      post.castShadow = true;
      g.add(post);
    }
    frame.castShadow = true;
    const dir = mapDir(b.at[0], b.at[1]);
    const fwd = tangentToward(dir, mapDir(b.face[0], b.face[1]));
    g.position.copy(dir).multiplyScalar(R);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(dir, fwd), dir, fwd));
    scene.add(g);
    colliders.push({ dir: dir.clone(), r: 1.9 });
    return { ...b, canvas, tex, group: g, ads: [], i: 0, shown: null, front: () => g.localToWorld(new THREE.Vector3(0, 0, 2.2)), top: () => g.localToWorld(new THREE.Vector3(0, 4.6, 0)) };
  });
  const imgCache = new Map();
  async function showAd(board, ad) {
    board.shown = ad;
    let img = null;
    if (ad?.image) {
      if (!imgCache.has(ad.image)) imgCache.set(ad.image, loadImg(ad.image));
      img = await imgCache.get(ad.image);
    }
    if (board.shown !== ad) return; // rotated on meanwhile
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
    const say = { live: `Your ad “${a.title}” is live on the ${BOARDS.find((b) => b.id === a.boardId)?.label}!`, awaiting_rent: `Your ad “${a.title}” was approved. Pay the rental to put it up.`, rejected: `Your ad “${a.title}” wasn't approved.` }[a.status];
    if (say) {
      chime();
      ui.toast(say, 6000);
    }
  });
  const refreshAds = () => api("/api/ads").then((d) => setLive(d.ads)).catch(() => {});

  async function openBoard(boardId, msg = "") {
    view = "board";
    show();
    const b = boards.find((x) => x.id === boardId);
    const ad = b.shown;
    let mine = [];
    try {
      mine = (await api("/api/ads/mine")).ads;
    } catch {
      /* not joined yet */
    }
    render(`${head(esc(b.label))}
      ${ad ? `<article class="ad-card"><p class="ad-kicker">${ad.rented ? "Sponsored" : "Advertisement"} · by ${esc(ad.authorName)}</p><h3>${esc(ad.title)}</h3>${ad.text ? `<p>${esc(ad.text)}</p>` : ""}
        ${ad.link ? `<p><a href="${esc(ad.link)}" target="_blank" rel="noopener noreferrer nofollow" data-ext>${esc(new URL(ad.link).hostname)} ↗</a> <small class="muted">(leaves OMEN)</small></p>` : ""}
        <p class="post-acts"><button class="link" data-report-ad="${esc(ad.id)}">Report this ad</button></p></article>` : `<p>This hoarding is free. Put your stall, your project or a friendly message in front of every courier who walks past.</p>`}
      ${msg}
      <details ${ad ? "" : "open"}><summary>Advertise here</summary>
        <form class="form" id="ad-f">
          <label>Image <small class="muted">(PNG, JPEG or WebP; resized in your browser)</small><input type="file" name="file" accept="image/png,image/jpeg,image/webp"></label>
          <label>Headline<input name="title" maxlength="40" required></label>
          <label>Line of text<input name="text" maxlength="90"></label>
          <label>Link <small class="muted">(optional, https only)</small><input name="link" type="url" placeholder="https://" maxlength="200"></label>
          <fieldset><legend>Run it for</legend>${AD_DAYS.map((d, i) => `<label><input type="radio" name="days" value="${d}" ${i ? "" : "checked"}> ${d} day${d > 1 ? "s" : ""} · ${d === 1 ? "free" : formatInr(d * AD_RENT_PAISE_PER_DAY) + " rental (testnet USDT or DEMO), after approval"}</label>`).join("")}</fieldset>
          <p class="fine">Preview: exactly how it will look on the hoarding.</p>
          <canvas id="ad-preview" width="1024" height="576" class="ad-preview"></canvas>
          <button class="btn small">Submit for review</button>
          <p class="fine">A moderator approves every ad before it appears. No scams, no hate, nothing you don't have the rights to.</p>
        </form></details>
      ${mine.length ? `<h3>Your ads</h3><ul class="hist">${mine.map((a) => `<li><div><b>${esc(a.title)}</b><small>${esc(BOARDS.find((x) => x.id === a.boardId)?.label)} · ${a.days} day${a.days > 1 ? "s" : ""} · ${esc({ pending: "waiting for review", awaiting_rent: "approved: pay rental to go live", live: "LIVE", rejected: "not approved", expired: "expired" }[a.status] || a.status)}</small></div>
        ${a.status === "awaiting_rent" ? `<span><button class="btn small" data-rent="${esc(a.id)}" data-tok="USDT">Pay USDT</button> <button class="btn small ghost" data-rent="${esc(a.id)}" data-tok="DEMO">Pay DEMO</button></span>` : ""}</li>`).join("")}</ul>` : ""}`);
    const form = body.querySelector("#ad-f");
    const preview = body.querySelector("#ad-preview");
    let image = null;
    let imgEl = null;
    const draw = () => {
      const f = Object.fromEntries(new FormData(form));
      paintBoard(preview, { title: f.title || "Your headline", text: f.text, rented: Number(f.days) > 1 }, imgEl);
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
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const btn = form.querySelector("button.btn");
      btn.disabled = true;
      btn.textContent = "Uploading…";
      try {
        await api("/api/ads", { boardId, title: f.title, text: f.text, link: f.link || null, days: Number(f.days), image, name: myName() });
        openBoard(boardId, `<p class="ok">Submitted! A moderator will review it; you'll get a note here when it's decided.</p>`);
      } catch (er) {
        openBoard(boardId, err(er));
      }
    };
    body.querySelector("[data-report-ad]")?.addEventListener("click", (e) => report("ad", ad.id, e.target));
    body.querySelector("[data-ext]")?.addEventListener("click", (e) => {
      if (!confirm(`This link leaves OMEN for ${new URL(ad.link).hostname}. Never enter a seed phrase or private key anywhere. Continue?`)) e.preventDefault();
    });
    body.querySelectorAll("[data-rent]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            const { payment } = await api(`/api/ads/${b.dataset.rent}/rent`, { token: b.dataset.tok });
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
