// OMEN venue, phase 1: the arrival hall, the branching columns, architectural lighting and the
// Main Stage, in a stylised interpretation of the exhibition halls of Jio World Convention Centre.
// A separate scene from the Blockhaven planet; it reuses the same avatars, animations, identity
// and multiplayer server (positions are encoded so the server needs no changes).
import "../style.css";
import "./expo.css";
import * as THREE from "three";
import { loadAll } from "../assets.js";
import { Character } from "../character.js";
import { applyLook, syncPet, Pet } from "../avatar.js";
import { createNet, roomFromUrl } from "../net.js";
import { createPerf } from "../perf.js";
import { paintBoard } from "../community.js";
import * as L from "./layout.js";
import { buildVenue } from "./venue.js";
import { buildStage } from "./stage.js";
import { createMap } from "./map.js";
import { buildStations } from "./stations.js";
import { createPanel } from "./panel.js";

const $ = (s) => document.querySelector(s);
const MOBILE = matchMedia("(pointer: coarse)").matches;
const params = new URLSearchParams(location.search);
Pet.flatWorld = true;

// ------------------------------------------------------------------ renderer + scene
const canvas = $("#scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, powerPreference: "high-performance" });
const basePR = Math.min(devicePixelRatio || 1, MOBILE ? 1.25 : 1.5);
renderer.setPixelRatio(basePR);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd9d1c4);
scene.fog = new THREE.Fog(0xd9d1c4, 70, 210);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 260);

// Restrained lighting: sky/ground fill, one shadow-casting "daylight" that follows the player
// (a small shadow frustum, not the whole hall), and the stage's single spot. The canopies,
// LED bars and screens are emissive/unlit: no per-fixture lights.
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x6e6458, 2.2));
const sun = new THREE.DirectionalLight(0xfff0dc, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const perf = createPerf({ renderer, sun, basePR, mobile: MOBILE, apply: (pr) => renderer.setPixelRatio(pr) });
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ HUD helpers
const toast = (text, ms = 3200) => {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.remove("in");
  void t.offsetWidth;
  t.classList.add("in");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
};
const feed = (text) => {
  const li = document.createElement("li");
  li.textContent = text;
  $("#feed").prepend(li);
  setTimeout(() => li.classList.add("fade"), 5200);
  setTimeout(() => li.remove(), 6000);
  while ($("#feed").children.length > 4) $("#feed").lastChild.remove();
};

// ------------------------------------------------------------------ load
const progress = (p) => ($("#load-bar").style.transform = `scaleX(${p})`);
await loadAll(["kai", "tree_column"], progress);
const venue = buildVenue(scene);
const stage = buildStage(scene);
const corridor = buildStations(scene);
$("#loading").classList.add("gone");
setTimeout(() => $("#loading").remove(), 600);

// ------------------------------------------------------------------ the local avatar
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("omen.courier") || "{}");
  } catch {
    return {};
  }
})();
const me = { x: L.SPAWN.x, z: L.SPAWN.z, y: 0, vy: 0, yaw: L.SPAWN.yaw, speed: 0, grounded: true, name: saved.name || "", look: saved.look || null };
const kai = new Character("kai", { unique: true });
const holder = { pet: null };
scene.add(kai.group);
function setLook(look) {
  applyLook(kai, look || {});
  syncPet(scene, holder, kai.look.pet);
}
setLook(me.look);
const R_PLAYER = 0.42;

// ------------------------------------------------------------------ input
const keys = new Set();
let busy = false; // a sheet or the map is open
let mode = "intro";
const input = { x: 0, y: 0, run: false };
addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if (k === "m" && mode === "play") return map.toggle();
  if (busy || mode !== "play") return;
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "shift"].includes(k)) e.preventDefault();
  keys.add(k);
  if (k === "e" && near) near.run();
  if (k === " " && me.grounded) (me.vy = 5.2), (me.grounded = false);
  if (["1", "2", "3"].includes(k)) travel(`p${k}`);
  if (k === "0") travel("concourse");
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());
function readKeys() {
  const has = (...k) => k.some((x) => keys.has(x));
  input.x = (has("d", "arrowright") ? 1 : 0) - (has("a", "arrowleft") ? 1 : 0);
  input.y = (has("w", "arrowup") ? 1 : 0) - (has("s", "arrowdown") ? 1 : 0);
  input.run = has("shift");
}

// Camera: orbit around the player with the mouse (drag) or touch (right half); wheel to zoom.
const cam = { orbit: 0, pitch: 0.32, dist: 8.5 };
let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (mode !== "play") return;
  if (e.pointerType === "touch" && e.clientX < innerWidth / 2) return; // left half: the joystick
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  cam.orbit -= (e.clientX - drag.x) * 0.006;
  cam.pitch = THREE.MathUtils.clamp(cam.pitch + (e.clientY - drag.y) * 0.004, 0.05, 1.1);
  drag.x = e.clientX;
  drag.y = e.clientY;
});
const endDrag = () => (drag = null);
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("lostpointercapture", endDrag);
canvas.addEventListener("wheel", (e) => (cam.dist = THREE.MathUtils.clamp(cam.dist + e.deltaY * 0.01, 3.5, 16)), { passive: true });

// Touch joystick (left half of the screen).
const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
const knob = $("#stick");
addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch" || mode !== "play" || busy || e.clientX >= innerWidth / 2 || e.target !== canvas) return;
  Object.assign(stick, { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 });
  knob.hidden = false;
  knob.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
});
addEventListener("pointermove", (e) => {
  if (e.pointerId !== stick.id) return;
  const dx = e.clientX - stick.ox;
  const dy = e.clientY - stick.oy;
  const m = Math.min(1, Math.hypot(dx, dy) / 60);
  const a = Math.atan2(dy, dx);
  stick.x = Math.cos(a) * m;
  stick.y = -Math.sin(a) * m;
});
const endStick = (e) => e.pointerId === stick.id && ((stick.id = null), (stick.x = stick.y = 0), (knob.hidden = true));
addEventListener("pointerup", endStick);
addEventListener("pointercancel", endStick);

// ------------------------------------------------------------------ movement
const SOLIDS = L.solidBoxes();
const CAM_BLOCKERS = L.wallBoxes().concat(L.propBoxes().filter((b) => b.kind === "screen" || b.kind === "station")); // stalls stop the camera too
const WALK = 4.4;
const RUN = 7.6; // the server caps reported speed at 8 m/s
function move(dt) {
  readKeys();
  let mx = input.x + stick.x;
  let my = input.y + stick.y;
  if (busy || mode !== "play") mx = my = 0;
  const mag = Math.min(1, Math.hypot(mx, my));
  // camera-relative: forward is where the camera looks, right is forward × up
  const fx = -Math.sin(cam.orbit);
  const fz = -Math.cos(cam.orbit);
  const rx = -fz;
  const rz = fx;
  let wx = fx * my + rx * mx;
  let wz = fz * my + rz * mx;
  const wl = Math.hypot(wx, wz);
  if (wl > 1e-4) (wx /= wl), (wz /= wl);
  const target = mag > 0.05 ? (input.run || mag > 0.95 && stick.id != null ? RUN : WALK) * mag : 0;
  me.speed += (target - me.speed) * Math.min(1, dt * (target > me.speed ? 5.5 : 8));
  if (mag > 0.05) {
    const want = Math.atan2(wx, wz);
    let d = want - me.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    me.yaw += d * Math.min(1, dt * 12);
  }
  const step = me.speed * dt;
  let nx = me.x + Math.sin(me.yaw) * step;
  let nz = me.z + Math.cos(me.yaw) * step;
  // a wall of more than one step (the stage edge) blocks like any other wall
  const here = L.groundAt(me.x, me.z);
  if (L.groundAt(nx, nz) - Math.max(here, me.y) > L.STEP_UP) {
    if (L.groundAt(nx, me.z) - Math.max(here, me.y) <= L.STEP_UP) nz = me.z;
    else if (L.groundAt(me.x, nz) - Math.max(here, me.y) <= L.STEP_UP) nx = me.x;
    else (nx = me.x), (nz = me.z);
  }
  ({ x: me.x, z: me.z } = L.collide(nx, nz, R_PLAYER, SOLIDS));
  // vertical: gravity, landing on the floor, deck or steps
  const ground = L.groundAt(me.x, me.z);
  me.vy -= 16 * dt;
  me.y += me.vy * dt;
  if (me.y <= ground) {
    if (ground - me.y < L.STEP_UP + 0.05 || me.grounded) me.y = ground;
    me.vy = 0;
    me.grounded = true;
  } else if (me.y - ground > 0.05) me.grounded = false;
  if (me.grounded && me.y > ground) me.y = Math.max(ground, me.y - dt * 4); // step down smoothly
  kai.group.position.set(me.x, me.y, me.z);
  kai.group.rotation.set(0, me.yaw, 0);
  kai.speed = me.speed;
  kai.air = !me.grounded;
}

const head = new THREE.Vector3();
function updateCamera(dt) {
  head.set(me.x, me.y + 1.7, me.z);
  const cp = Math.cos(cam.pitch);
  let bx = head.x + Math.sin(cam.orbit) * cp * cam.dist;
  let bz = head.z + Math.cos(cam.orbit) * cp * cam.dist;
  // never through a wall or the LED wall: stop just in front of the first one in the way
  // (pad 0.25 < the player's radius, so the head itself is never inside a padded wall)
  const t = L.clipSegment(head.x, head.z, bx, bz, CAM_BLOCKERS, 0.25);
  const k = Math.max(0.02, t - 0.02);
  bx = head.x + (bx - head.x) * k;
  bz = head.z + (bz - head.z) * k;
  const ceiling = me.z < 0 ? L.HALL_H - 0.6 : L.CONCOURSE_H - 0.6;
  const by = Math.min(ceiling, head.y + Math.sin(cam.pitch) * cam.dist * k);
  camera.position.set(bx, Math.max(0.6, by), bz);
  camera.lookAt(head);
  sun.position.set(me.x - 18, 34, me.z + 26);
  sun.target.position.set(me.x, 0, me.z);
}

// ------------------------------------------------------------------ interactions
const hint = $("#prompt");
let near = null;
const INTERACT = [
  { at: () => ({ x: L.BOUNDS.x1 - 2.2, z: L.VILLAGE_DOOR.z }), range: 3.4, label: "Go back to Blockhaven village", run: () => (location.href = `./index.html${location.search}`) },
  { at: () => ({ x: L.SPAWN.x, z: 5.6 }), range: 2.8, label: "Read the venue guide", run: () => map.open() },
  ...L.PAVILIONS.filter((p) => !p.open).map((p) => ({ at: () => ({ x: p.cx, z: -2.2 }), range: 4.5, label: `${p.name}: ${p.theme} (opening soon)`, run: () => toast(p.blurb, 5200) })),
  // every exhibitor station, from its counter front
  ...corridor.stations.map((st) => ({
    key: st.key,
    at: () => st.front,
    range: 2.4,
    label: st.kind === "food" ? "Grab a chai at Food & Drinks" : st.kind === "washroom" ? "Washrooms" : st.kind === "mentor" ? "Sit down at the Mentor Station" : `Visit ${st.name}`,
    run: () => panel.open(st),
  })),
  { at: () => ({ x: L.STAGE.screen.x, z: L.STAGE.z1 + 1.4 }), range: 3.2, label: "What's on the Main Stage?", run: () => toast("The Main Stage hosts keynotes and finalist demos. The LED wall shows live, moderator-approved player ads between sessions.", 5600) },
];
function findNear() {
  let best = null;
  let bd = Infinity;
  for (const it of INTERACT) {
    const p = it.at();
    const d = Math.hypot(p.x - me.x, p.z - me.z);
    if (d < it.range && d < bd) (best = it), (bd = d);
  }
  return best;
}
function showPrompt() {
  near = !busy && mode === "play" ? findNear() : null;
  if (!near) return (hint.hidden = true);
  $("#prompt-text").textContent = near.label;
  const v = new THREE.Vector3(me.x, me.y + 2.6, me.z).project(camera);
  hint.hidden = false;
  hint.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
}
$("#act").onclick = () => near?.run();

const panel = createPanel({
  toast,
  myName: () => me.name || "Guest",
  onCheer: () => (kai.cheer = 1.2),
  onOpenChange: (open) => (keys.clear(), (busy = open || map.isOpen)),
});

// ------------------------------------------------------------------ multiplayer (same server, own room)
const room = roomFromUrl() ? `expo-${roomFromUrl()}`.slice(0, 24) : "omen-expo";
const net = createNet({
  scene,
  camera,
  feed,
  worldName: "the venue",
  onCount: ({ online, connected }) => ($("#online").textContent = connected ? `${online} in the venue` : "offline: reconnecting…"),
  place(group, d, f, h) {
    const p = L.decodePos(d.toArray());
    group.position.set(p.x, h, p.z);
    group.rotation.set(0, Math.atan2(f.x, f.z), 0);
  },
  local: () => ({ d: L.encodePos(me.x, me.z), f: [Math.sin(me.yaw), 0, Math.cos(me.yaw)], h: me.y, sp: me.speed, air: !me.grounded, talk: false, hold: false }),
});

// ------------------------------------------------------------------ map and quick travel
const map = createMap({
  getPlayer: () => me,
  getRemotes: () => [...net.remotes.values()].map((r) => r.c.group.position),
  onTravel: travel,
});
function travel(key) {
  const p = L.PLACES.find((x) => x.key === key);
  if (!p) return;
  const fade = $("#fade");
  fade.classList.add("on");
  setTimeout(() => {
    me.x = p.x;
    me.z = p.z;
    me.y = L.groundAt(p.x, p.z);
    me.yaw = p.yaw;
    me.speed = 0;
    cam.orbit = p.yaw - Math.PI;
    fade.classList.remove("on");
    toast(p.label, 2200);
  }, 220);
}

// ------------------------------------------------------------------ LED screens: welcome, wayfinding, live ads
let liveAds = [];
const imgs = new Map();
const loadImg = (src) => {
  if (!imgs.has(src)) imgs.set(src, new Promise((res) => Object.assign(new Image(), { onload: (e) => res(e.target), onerror: () => res(null), src })));
  return imgs.get(src);
};
async function refreshAds() {
  try {
    liveAds = (await (await fetch("/api/ads")).json()).ads || [];
  } catch {
    liveAds = [];
  }
}
net.on("ads:update", (ads) => (liveAds = ads));
function slide(g, w, h, kicker, title, sub, color = "#c8473d") {
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#14121a");
  bg.addColorStop(1, "#22203a");
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = color;
  g.fillRect(0, h - 10, w, 10);
  g.textAlign = "center";
  g.fillStyle = "#9fb0ff";
  g.font = `800 ${Math.round(h * 0.09)}px 'Bricolage Grotesque', system-ui, sans-serif`;
  g.fillText(kicker, w / 2, h * 0.24, w * 0.9);
  g.fillStyle = "#fbf3e4";
  g.font = `800 ${Math.round(h * 0.2)}px 'Bricolage Grotesque', system-ui, sans-serif`;
  g.fillText(title, w / 2, h * 0.52, w * 0.92);
  g.font = `${Math.round(h * 0.1)}px 'Patrick Hand', cursive`;
  g.fillStyle = "#e8e1d3";
  g.fillText(sub, w / 2, h * 0.74, w * 0.9);
}
const SLIDES = [
  (g, w, h) => slide(g, w, h, "WELCOME TO", "OMEN · Mumbai", "a stylised venue inspired by Jio World Convention Centre"),
  (g, w, h) => slide(g, w, h, "PAVILION 1 · WEST", "Main Stage ←", "keynotes and finalist demos · walk up the side steps"),
  (g, w, h) => slide(g, w, h, "COMING NEXT", "Ads & Sponsor Expo", "claim these screens for your own ad in phase 2", "#3e8e8a"),
];
let slideI = 0;
async function paintScreens() {
  const ads = liveAds.length ? liveAds : [];
  slideI++;
  for (const [i, s] of [...venue.screens, ...stage.screens].entries()) {
    const g = s.canvas.getContext("2d");
    const n = SLIDES.length + ads.length;
    const k = (slideI + i) % n;
    const W = s.canvas.width;
    const H = s.canvas.height;
    if (W / H > 4) {
      // the long banner: one line of wayfinding, never squashed
      g.fillStyle = "#14121a";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#fbf3e4";
      g.textAlign = "center";
      g.font = `800 ${Math.round(H * 0.5)}px 'Bricolage Grotesque', system-ui, sans-serif`;
      g.fillText(["OMEN · MUMBAI", "← 1 MAIN STAGE   ·   2 ADS & EXPO ↑   ·   3 LOUNGE →", ads.length ? `LIVE: ${ads[slideI % ads.length].brand} · ${ads[slideI % ads.length].title}` : "WELCOME, COURIER"][slideI % 3], W / 2, H * 0.68, W * 0.94);
    } else if (k < SLIDES.length) {
      if (W / H >= 1.4) SLIDES[k](g, W, H);
      else {
        // portrait screens get a letterboxed 16:9 slide instead of squashed text
        const tmp = Object.assign(document.createElement("canvas"), { width: 1024, height: 576 });
        SLIDES[k](tmp.getContext("2d"), 1024, 576);
        g.fillStyle = "#121018";
        g.fillRect(0, 0, W, H);
        const sc = W / 1024;
        g.drawImage(tmp, 0, (H - 576 * sc) / 2, W, 576 * sc);
      }
    } else {
      const ad = ads[k - SLIDES.length];
      // reuse the hoarding painter on a 16:9 canvas, then fit it onto this screen
      const tmp = Object.assign(document.createElement("canvas"), { width: 1024, height: 576 });
      paintBoard(tmp, ad, ad.image ? await loadImg(ad.image) : null);
      g.fillStyle = "#121018";
      g.fillRect(0, 0, s.canvas.width, s.canvas.height);
      const sc = Math.min(s.canvas.width / 1024, s.canvas.height / 576);
      g.drawImage(tmp, (s.canvas.width - 1024 * sc) / 2, (s.canvas.height - 576 * sc) / 2, 1024 * sc, 576 * sc);
    }
    s.tex.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ intro: name + enter
function begin() {
  const name = $("#ex-name").value.trim().slice(0, 16) || "Guest";
  me.name = name;
  try {
    localStorage.setItem("omen.courier", JSON.stringify({ ...saved, name, look: kai.look }));
  } catch {
    /* ignore */
  }
  document.activeElement?.blur?.(); // WASD must reach the game, not the name field
  $("#intro").hidden = true;
  $("#hud").hidden = false;
  mode = "play";
  net.join({ room, name, look: kai.look });
  toast("Welcome to the arrival hall. Main Stage is through the west portal (or press 1).", 4200);
}
$("#ex-name").value = me.name;
$("#ex-enter").onclick = begin;
$("#ex-form").onsubmit = (e) => (e.preventDefault(), begin());
if (params.has("auto")) begin(); // tests and kiosk mode

// ------------------------------------------------------------------ loop
cam.orbit = me.yaw - Math.PI;
await refreshAds();
paintScreens();
setInterval(paintScreens, 7000);
const clock = new THREE.Clock();
const frameTimes = []; // for the frame-pacing probe
let probe = null;
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  busy = map.isOpen || panel.isOpen;
  move(dt);
  kai.update(dt, t);
  holder.pet?.update(dt, kai.group, me.speed);
  updateCamera(dt);
  showPrompt();
  net.update(dt, t);
  map.update(dt);
  for (const [i, b] of stage.beams.entries()) b.material.opacity = 0.26 + Math.sin(t * 0.8 + i) * 0.08;
  perf.frame(dt);
  renderer.render(scene, camera);
  if (probe) {
    const now = performance.now();
    if (probe.last) probe.d.push(now - probe.last);
    probe.last = now;
  }
});

// Test / diagnostics hook (read-only views plus teleport and a frame-pacing probe).
window.__expo = {
  THREE,
  scene,
  camera,
  renderer,
  me,
  kai,
  cam,
  net,
  layout: L,
  stage,
  venue,
  corridor,
  panel,
  interactAt: () => near?.key || near?.label || null,
  get mode() {
    return mode;
  },
  travel,
  keys,
  perf,
  /** Record real frame-to-frame times for `ms` and summarise them (average AND pacing). */
  async sample(ms = 5000) {
    probe = { d: [], last: 0 };
    await new Promise((r) => setTimeout(r, ms));
    const d = probe.d.slice().sort((a, b) => a - b);
    probe = null;
    const q = (p) => d[Math.min(d.length - 1, Math.floor(d.length * p))];
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      frames: d.length,
      avgFps: 1000 / avg,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
      worst: d[d.length - 1],
      over20ms: d.filter((x) => x > 20).length,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      quality: perf.level,
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown",
    };
  },
};
