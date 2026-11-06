// Final Block step 3: after the tutorial, a 3-minute countdown, then KAI falls from Blockhaven into
// a second tiny planet, "Mumbai". It reuses the planet shader and the ink pass: Mumbai is built on
// the same sphere (radius R) and swapped in while the camera is far away, so movement, camera and
// colliders all keep working unchanged.
import * as THREE from "three";
import { P, R } from "../palette.js";
import { mapDir, tangentToward, placeMap, makePlanet, smoothPath } from "../planet.js";
import { loadAll, model, grad, toon } from "../assets.js";

export const MUMBAI_MODELS = ["gateway_arch", "kaali_peeli", "local_train", "vada_pav_cart", "sea_wall"];
export const COUNTDOWN_S = 180;

// Map layout (metres on the flat map wrapped onto the sphere; the plaza is at the pole).
const PLAZA = [0, 0, 7.5];
export const BOOTH_SPOTS = [
  { id: "finalists", at: [8.5, 4], color: 0xf2c230 },
  { id: "crossover", at: [-8.5, 4], color: 0x3e8e8a },
  { id: "tracks", at: [-6, -8], color: 0xc8473d },
  { id: "problems", at: [6, -8], color: 0x8e3b46 },
];
const PROPS = [
  // [model, x, z, faceX, faceZ, scale, collider radius]
  ["gateway_arch", 0, 15, 0, 0, 1, 4.2],
  ["sea_wall", -9, 20, -6, 14, 1, 0],
  ["sea_wall", 9, 20, 6, 14, 1, 0],
  ["kaali_peeli", 12, 10, 20, 2, 1, 1.5],
  ["kaali_peeli", -13, 9, -20, 1, 1, 1.5],
  ["local_train", -15, -12, -21, -2, 1, 3.4],
  ["vada_pav_cart", 2.5, -12, 0, 0, 1, 0.9],
  ["vada_pav_cart", -12, -3, 0, 0, 1, 0.9],
];
const LANES = [
  [[0, 7], [0, 11.5]],
  ...BOOTH_SPOTS.map((b) => [[b.at[0] * 0.55, b.at[1] * 0.55], [b.at[0] * 0.85, b.at[1] * 0.85]]),
  [[0, -7], [1, -11], [2.5, -10.5]],
];

/** The Mumbai planet: Blockhaven's shader with sand, sea-front promenade and basalt paving. */
function mumbaiPlanet() {
  const saved = { grass: P.grass, grassDark: P.grassDark, meadow: P.meadow, cobble: P.cobble, cobbleDark: P.cobbleDark };
  Object.assign(P, { grass: 0xe2c48f, grassDark: 0xcfae78, meadow: 0x9cc6c9, cobble: 0xd8b47a, cobbleDark: 0xb48e58 });
  try {
    const segs = [];
    for (const l of LANES.map((l) => smoothPath(l, 1.4))) for (let i = 0; i < l.length - 1; i++) segs.push([l[i], l[i + 1]]);
    return makePlanet(segs, [PLAZA, [0, 12.5, 3.5]], grad);
  } finally {
    Object.assign(P, saved);
  }
}

function signTexture(title, sub) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 192;
  const g = c.getContext("2d");
  g.fillStyle = "#FBF3E4";
  g.fillRect(0, 0, 512, 192);
  g.strokeStyle = "#2B2230";
  g.lineWidth = 12;
  g.strokeRect(6, 6, 500, 180);
  g.fillStyle = "#2B2230";
  g.textAlign = "center";
  g.font = "800 50px 'Bricolage Grotesque', system-ui, sans-serif";
  g.fillText(title, 256, 92, 470);
  g.font = "700 26px system-ui, sans-serif";
  g.fillStyle = "#8a5a1c";
  g.fillText(sub, 256, 148, 470);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A small prediction booth: counter, posts, striped awning and a sign. Front faces +Z. */
function makeBooth(name, color) {
  const g = new THREE.Group();
  const ink = toon(0x2b2230);
  const body = toon(color);
  const cream = toon(0xfbf3e4);
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(2.4, 1.0, 1.0), body, 0, 0.5, 0);
  add(new THREE.BoxGeometry(2.5, 0.08, 1.1), cream, 0, 1.04, 0);
  for (const x of [-1.15, 1.15]) for (const z of [-0.45, 0.45]) add(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), ink, x, 1.2, z);
  for (let i = 0; i < 6; i++) {
    const s = add(new THREE.BoxGeometry(0.44, 0.06, 1.5), i % 2 ? body : cream, -1.1 + i * 0.44, 2.45, 0.15);
    s.rotation.x = -0.25;
  }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.86), new THREE.MeshBasicMaterial({ map: signTexture(name, "TESTNET ONLY · JUST FOR FUN") }));
  sign.position.set(0, 3.05, 0.4);
  g.add(sign);
  return g;
}

/**
 * ctx: { scene, W, kai, mover, rig, camera, talkables, ui, getMode, setMode, onBooth(id), boothName(id) }
 */
export function createMumbai(ctx) {
  const { scene, W, kai, mover, rig, camera, talkables, ui } = ctx;
  const group = new THREE.Group();
  group.name = "mumbai";
  group.visible = false;
  let built = false;
  let active = false;
  const colliders = [];
  const blockers = [];
  const booths = [];
  const saved = { children: [], talk: null, colliders: null, blockers: null };

  async function build() {
    if (built) return;
    built = true;
    await loadAll(MUMBAI_MODELS);
    group.add(mumbaiPlanet());
    for (const [name, x, z, fx, fz, s, r] of PROPS) {
      const o = model(name);
      placeMap(o, x, z, fx, fz, s);
      group.add(o);
      if (r) colliders.push({ dir: mapDir(x, z), r });
      if (name === "gateway_arch" || name === "local_train") blockers.push(o);
    }
    for (const b of BOOTH_SPOTS) {
      const o = makeBooth(ctx.boothName(b.id), b.color);
      placeMap(o, b.at[0], b.at[1], 0, 0);
      group.add(o);
      colliders.push({ dir: mapDir(b.at[0], b.at[1]), r: 1.3 });
      blockers.push(o);
      booths.push({ ...b, group: o });
    }
    scene.add(group);
  }

  const mumbaiTalk = () =>
    booths.map((b) => ({
      label: `${ctx.boothName(b.id)} · predict (testnet)`,
      at: () => b.group.localToWorld(new THREE.Vector3(0, 0, 1.4)),
      head: () => b.group.localToWorld(new THREE.Vector3(0, 3.7, 0)),
      run: async () => ctx.onBooth(b.id),
      range: 2.4,
    }));

  /** Swap Blockhaven out and Mumbai in (in place: the mover and camera rig keep their arrays). */
  function swapIn() {
    const keep = new Set([kai.group, W.sky, group, camera]);
    saved.children = scene.children.filter((o) => o.visible && !keep.has(o) && !o.isLight);
    for (const o of saved.children) o.visible = false;
    group.visible = true;
    saved.talk = talkables.splice(0, talkables.length, ...mumbaiTalk());
    saved.colliders = W.colliders.splice(0, W.colliders.length, ...colliders);
    saved.blockers = W.camBlockers.splice(0, W.camBlockers.length, ...blockers);
    const sky = W.sky.material.uniforms;
    saved.sky = [sky.uLow.value.clone(), sky.uHigh.value.clone()];
    sky.uLow.value.set(0xf4b183);
    sky.uHigh.value.set(0x8fb4d9);
    const spawn = mapDir(0, -4.5);
    mover.dir.copy(spawn);
    mover.fwd.copy(tangentToward(spawn, mapDir(0, 15)));
    mover.apply();
    active = true;
    document.body.dataset.world = "mumbai";
  }

  // ---------------------------------------------------------------- countdown + fall
  let countdown = null;
  const hud = document.createElement("div");
  hud.id = "mumbai-countdown";
  hud.hidden = true;
  hud.innerHTML = `<span>Mumbai opens in <b>3:00</b></span><button type="button" class="btn small">Fall now</button>`;
  document.body.append(hud);
  hud.querySelector("button").onclick = () => fall();

  function startCountdown(seconds = COUNTDOWN_S) {
    if (active || countdown) return;
    build(); // preload while the clock runs
    const end = performance.now() + seconds * 1000;
    hud.hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((end - performance.now()) / 1000));
      hud.querySelector("b").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      if (left <= 0) fall();
    };
    tick();
    countdown = setInterval(tick, 250);
  }

  const veil = document.createElement("div");
  veil.id = "fall-veil";
  veil.innerHTML = "<p>Falling into <b>Mumbai</b>…</p>";
  document.body.append(veil);

  let f = null;
  async function fall() {
    if (active || f) return;
    clearInterval(countdown);
    countdown = null;
    hud.hidden = true;
    ctx.ui.closeDialogue?.();
    await build();
    const from = { pos: camera.position.clone(), q: camera.quaternion.clone() };
    const out = kai.group.position.clone().normalize();
    const hi = out.clone().multiplyScalar(R * 5.5);
    f = { t: 0, from, hi, swapped: false, to: null };
    ctx.setMode("fall");
  }

  /** Called from the frame loop while mode === "fall". */
  function update(dt) {
    if (!f) return;
    f.t += dt;
    const A = 1.6;
    const B = 3.0;
    if (f.t < A) {
      const e = easeInOut(f.t / A);
      camera.position.lerpVectors(f.from.pos, f.hi, e);
      camera.lookAt(0, 0, 0);
      veil.style.opacity = String(Math.max(0, (f.t / A - 0.6) / 0.4));
      veil.classList.add("on");
    } else {
      if (!f.swapped) {
        f.swapped = true;
        swapIn();
        rig.fwd.copy(mover.fwd);
        rig.snap(mover);
        f.to = { pos: camera.position.clone(), q: camera.quaternion.clone() };
        f.top = mover.dir.clone().multiplyScalar(R * 6).addScaledVector(mover.fwd, -R * 0.6);
      }
      const k = Math.min(1, (f.t - A) / B);
      const e = 1 - Math.pow(1 - k, 3);
      veil.style.opacity = String(Math.max(0, 1 - k * 3));
      camera.position.lerpVectors(f.top, f.to.pos, e);
      const look = new THREE.Quaternion();
      const m = new THREE.Matrix4().lookAt(camera.position, new THREE.Vector3(0, 0, 0), mover.fwd);
      look.setFromRotationMatrix(m);
      camera.quaternion.copy(look).slerp(f.to.q, e);
      if (k >= 1) {
        f = null;
        veil.classList.remove("on");
        ctx.setMode("play");
        ui.toast("Welcome to Mumbai. Four prediction booths around the plaza. Testnet tokens only. No real money. Just for fun.", 6000);
        ctx.onArrive?.();
      }
    }
  }

  return { startCountdown, fall, update, get active() { return active; }, get counting() { return !!countdown; }, group, booths };
}

const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
