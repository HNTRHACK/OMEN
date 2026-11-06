import * as THREE from "three";
import { P, R } from "./palette.js";
import { loadAll } from "./assets.js";
import { buildWorld } from "./world.js";
import { mapDir, tangentToward, placeMap } from "./planet.js";
import { SPOTS } from "./layout.js";
import { Character } from "./character.js";
import { applyLook, syncPet } from "./avatar.js";
import { LOOK_OPTIONS, DEFAULT_LOOK, cleanLook, lookFromOutfit, randomLook } from "../shared/look.js";
import { FACE_OPTIONS, DEFAULT_FACE, cleanFace } from "../shared/face.js";
import { createSelfie } from "./selfie.js";
import * as worldId from "./world-id.js";
import { createNet, roomFromUrl, newRoomCode, inviteUrl } from "./net.js";
import { Collectibles } from "./collectibles.js";
import { createCoinCard } from "./coincard.js";
import { Mover, CameraRig } from "./player.js";
import { InkPass } from "./post.js";
import { Envelope, Particles, Smoke, Birds, flying } from "./fx.js";
import { ui, bindInput, clearHeldKeys } from "./ui.js";
import { audio } from "./audio.js";
import { toon, model } from "./assets.js";
import { createShops } from "./shop.js";
import { createCommunityUI } from "./community.js";
import { createAlfredUI, ALFRED_LOOK } from "./alfred.js";
import { PLACE_SHORT } from "../shared/places.js";
import { BOARDS } from "../shared/billboards.js";
import { PLOTS, SHOP_COLORS } from "../shared/storefronts.js";
import { initPay } from "./pay/index.js";
import { createPerf } from "./perf.js";
import "./style.css";

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MOBILE = matchMedia("(pointer: coarse)").matches;

// ------------------------------------------------------------------ renderer

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
const PR = Math.min(devicePixelRatio || 1, MOBILE ? 1.25 : 1.5);
renderer.setPixelRatio(PR);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(P.skyLow);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
scene.add(camera);

const hemi = new THREE.HemisphereLight(0xfff1dc, 0x8f7d9a, 1.25);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 90 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.04;
sun.shadow.radius = 3;
scene.add(hemi, sun, sun.target);

const ink = new InkPass(renderer);
let pr = PR; // current render scale; adaptive quality may lower it
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  ink.setSize(innerWidth, innerHeight, pr);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = innerWidth < innerHeight ? 62 : 50;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
const perf = createPerf({
  renderer,
  sun,
  basePR: PR,
  mobile: MOBILE,
  apply(p) {
    pr = p;
    renderer.setPixelRatio(p);
    resize();
  },
});

// ------------------------------------------------------------------ load

const MODELS = [
  "chai_shop", "workshop", "post_office", "house_a", "house_b", "house_c", "house_d",
  "tree_round", "tree_cypress", "tree_pine", "bush", "lantern_post", "bench", "fence", "planter", "crates",
  "signpost", "noticeboard", "relay_lantern", "well", "market_stall", "rocks", "string_pole",
  "kai", "maya", "orin", "echo",
];
await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]);
await loadAll(MODELS, (p) => ui.progress(p));

const W = buildWorld(scene);
const particles = new Particles(scene);
const birds = new Birds(scene);
const smoke = new Smoke(scene, [
  W.hero.chai.localToWorld(new THREE.Vector3(-1.45, 7.2, -1.1)),
  W.hero.workshop.localToWorld(new THREE.Vector3(2.32, 7.6, -0.9)),
]);

// ------------------------------------------------------------------ characters

const kai = new Character("kai", { unique: true }); // unique materials: outfits recolour only KAI
scene.add(kai.group);
kai.stepCb = (s) => audio.step(s);

function npcAt(name, building, local, faceLocal) {
  const c = new Character(name);
  building.add(c.group);
  c.group.position.copy(local);
  if (faceLocal) c.group.lookAt(building.localToWorld(faceLocal.clone()));
  return c;
}
const maya = npcAt("maya", W.hero.chai, new THREE.Vector3(0.7, 0.25, 0.45));
const orin = npcAt("orin", W.hero.workshop, new THREE.Vector3(1.7, 0, 4.0));
const echo = new Character("echo");
{
  const dir = mapDir(...SPOTS.lookout);
  const fwd = tangentToward(dir, mapDir(0, 0));
  echo.group.position.copy(dir).multiplyScalar(R);
  echo.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(dir, fwd), dir, fwd));
  echo.group.visible = false;
  scene.add(echo.group);
}
W.colliders.push({ dir: echo.group.position.clone().normalize(), r: 0.5 });

// Alfred, the advisor: the animated courier rig, dressed as an elderly mentor with a cane, standing
// by the plaza bench. (A dedicated Blender model is a follow-up: bpy isn't available here.)
const alfred = new Character("kai", { unique: true });
alfred.name = "alfred";
applyLook(alfred, ALFRED_LOOK);
{
  const wood = toon(P.wood);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.82, 8), wood);
  shaft.position.set(0.04, -0.85, 0.06);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), toon(P.butter));
  knob.position.set(0.04, -0.43, 0.06);
  for (const m of [shaft, knob]) {
    m.castShadow = true;
    alfred.p.armR.add(m);
  }
  // Spot chosen by measuring the live scene (clear of lanes, props and lamp posts, with a clear
  // sightline for a talking player), plus his own bench, same orientation as the plaza's benches.
  const dir = mapDir(0, -8);
  const bench = model("bench");
  placeMap(bench, 2.1, -8.2, 4.2, -16.4);
  bench.traverse((o) => o.isMesh && ((o.castShadow = true), (o.receiveShadow = true)));
  scene.add(bench);
  const fwd = tangentToward(dir, mapDir(0, 0));
  alfred.group.position.copy(dir).multiplyScalar(R);
  alfred.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(dir, fwd), dir, fwd));
  scene.add(alfred.group);
  W.colliders.push({ dir: dir.clone(), r: 0.55 });
}
const alfredTag = Object.assign(document.createElement("div"), { className: "nametag", innerHTML: '<span class="sw o4"></span>Alfred · advisor' });
document.body.append(alfredTag);

const spawnDir = mapDir(...SPOTS.spawn.at);
const mover = new Mover(kai, spawnDir, tangentToward(spawnDir, mapDir(...SPOTS.spawn.face)), W.colliders);
const rig = new CameraRig(camera, W.camBlockers);
const input = { x: 0, y: 0, run: false, jump: false };
mover.onJump = () => audio.jump();

// ------------------------------------------------------------------ quest state + save

const STAGES = {
  start: "Visit Maya's tea stall",
  toOrin: "Take the receipt to Orin's Relay Works",
  relight: "Relight Relay 03 in the plaza",
  backToOrin: "Return to Orin",
  deliver: "Deliver Orin's findings to Maya",
  echo: "Someone is waiting at the lookout",
  done: "Explore Blockhaven",
};
const ITEMS = {
  receipt: { icon: "receipt", name: "Pending receipt #4127", desc: "Ravi's payment for 40 cups of festival chai. Stuck on 'pending' since dawn.", simulated: true },
  lens: { icon: "lens", name: "Orin's block lens", desc: "Lets you read confirmations. Smells faintly of solder.", simulated: false },
  sealed: { icon: "sealed", name: "Orin's sealed findings", desc: "Proof that block 88 was signed by a node that doesn't exist.", simulated: true },
  tea: { icon: "tea", name: "A week of free chai", desc: "Maya's thank-you. Possibly two weeks.", simulated: false },
  alfredNote: { icon: "sealed", name: "Alfred's note of thanks", desc: "“Small steps, taken for real, are the whole trick.” Not money, not crypto: just encouragement.", simulated: false },
};
const state = { stage: "start", items: [], relay: false, festival: false };

function save() {
  try {
    localStorage.setItem("omen.save", JSON.stringify({ ...state, d: mover.dir.toArray(), f: mover.fwd.toArray() }));
  } catch {
    /* storage blocked */
  }
}
function load() {
  try {
    return JSON.parse(localStorage.getItem("omen.save") || "null");
  } catch {
    return null;
  }
}
function setStage(s) {
  state.stage = s;
  ui.objective(STAGES[s]);
  save();
}
function give(id) {
  if (!state.items.includes(id)) state.items.push(id);
  ui.setItems(state.items.map((i) => ITEMS[i]));
  ui.bumpSatchel();
  ui.toast(`Added to satchel: ${ITEMS[id].name}`);
  save();
}
function take(id) {
  state.items = state.items.filter((i) => i !== id);
  ui.setItems(state.items.map((i) => ITEMS[i]));
  save();
}

// ------------------------------------------------------------------ world reactions

function setRelay(on, burst = false) {
  state.relay = on;
  const m = W.crystal.material;
  m.color.set(on ? P.netGlow : 0x5d6b78);
  m.emissive.set(on ? P.netGlow : 0x000000);
  m.emissiveIntensity = on ? 1.3 : 0;
  if (burst) {
    const at = W.crystal.getWorldPosition(new THREE.Vector3());
    particles.burst(at, "spark", 70, 5);
    audio.zap();
  }
}
function setFestival(on) {
  state.festival = on;
  for (const m of W.lampMats) m.emissiveIntensity = on ? 1.6 : 0.25;
}
setRelay(false);
setFestival(false);

// ------------------------------------------------------------------ conversations

let busy = false;
const headOf = (c) => c.local(0, 1.75, 0);

async function converse(npc, fn) {
  net.act("talk", npc.name);
  clearHeldKeys();
  busy = true;
  mover.enabled = false;
  input.x = input.y = 0;
  mover.face(npc.group.getWorldPosition(new THREE.Vector3()));
  rig.talk = { a: headOf(kai), b: headOf(npc) };
  const local = npc.group.worldToLocal(kai.group.position.clone());
  npc.headTarget = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -0.9, 0.9);
  try {
    await fn();
  } finally {
    ui.closeDialogue();
    kai.talk = npc.talk = 0;
    npc.headTarget = 0;
    rig.talk = null;
    clearHeldKeys();
    mover.enabled = true;
    busy = false;
  }
}
async function line(who, char, text, opts) {
  kai.talk = char === kai ? 1 : 0;
  for (const c of [maya, orin, echo]) c.talk = c === char ? 1 : 0;
  return ui.say(who, text, opts);
}

async function talkMaya() {
  const at = state.stage;
  await converse(maya, async () => {
    if (state.stage === "start") {
      await line("MAYA", maya, "KAI! Thank the kettle, you came.");
      await line("MAYA", maya, "Ravi paid me for forty cups for tonight's lantern festival. My ledger says paid. The network says... pending.");
      const pick = await line("MAYA", maya, "Pending since dawn. Payments don't just vanish, do they?", {
        choices: [
          { label: "I'll find out where it went.", value: "go" },
          { label: "Maybe the network's just slow?", value: "slow" },
        ],
      });
      if (pick === "slow") await line("MAYA", maya, "Slow is ten minutes, KAI. This is a whole morning. The kettle's gone cold twice.");
      await line("MAYA", maya, "Take the receipt to Orin. If anyone can read the network's mind, it's that old relay-whisperer.");
      give("receipt");
      maya.wave = 1.2;
      setStage("toOrin");
    } else if (state.stage === "deliver") {
      await line("KAI", kai, "Sealed findings from Orin. Special delivery.");
      ui.closeDialogue();
      kai.holding = true;
      const env = new Envelope(scene);
      await env.fly(kai.local(0.35, 1.1, 0.3), maya.local(0.3, 1.25, 0.3), { height: 1.4, duration: 1.4 });
      kai.holding = false;
      take("sealed");
      pay.logDelivery({ id: "findings-88", to: "maya-chai", note: "Courier KAI delivered Orin's sealed findings on block 88 to Maya" });
      maya.holding = true;
      audio.chime([0, 7]);
      await line("MAYA", maya, "A block signed by... nobody? Who rewrites a tea seller's payment?");
      maya.holding = false;
      await line("MAYA", maya, "Wait. Look at the ledger. With Relay 03 back, Ravi's payment just went through. Confirmed!");
      celebrate();
      await line("MAYA", maya, "Lanterns tonight after all! Tea's on me for a week, KAI. Maybe two.");
      give("tea");
      await line("KAI", kai, "...Someone's standing up on the lookout. Watching.");
      setStage("echo");
      echo.group.visible = true;
    } else {
      const lines = {
        toOrin: "Orin's workshop is the round one with the crooked chimney. Up the winding lane, past the well.",
        relight: "If Orin says the lantern's dark, it's dark. He talks to those relays like they're his grandchildren.",
        backToOrin: "The plaza lantern's glowing again! Go on, Orin will want to see.",
        echo: "Who's that up at the lookout? I've never seen them at the stall.",
        done: "The kettle's on. It's always on, for you. And the QR on my sign takes crypto now, if you fancy a cup.",
      };
      await line("MAYA", maya, lines[state.stage] || lines.done);
      if (!["start", "deliver"].includes(at)) {
        const pick = await line("MAYA", maya, "Anything else? You can pay at the QR sign by the counter.", {
          choices: [
            { label: "Scan your QR to buy chai", value: "buy" },
            { label: "Just passing by", value: "no" },
          ],
        });
        if (pick === "buy") scanAfter = "maya-chai";
      }
    }
  });
}

async function talkOrin() {
  const at = state.stage;
  await converse(orin, async () => {
    if (state.stage === "start") {
      await line("ORIN", orin, "Mind the cables. Mind the other cables. Maya's looking for you, I think. Something about a payment.");
    } else if (state.stage === "toOrin") {
      await line("ORIN", orin, "A visitor! Mind the cables. And the other cables.");
      await line("ORIN", orin, "A pending receipt, eh? Let's see it through the block lens.");
      orin.holding = true;
      particles.burst(orin.local(0.3, 1.6, 0.4), "spark", 18, 2);
      await line("ORIN", orin, "Two confirmations out of three. The third relay never answered.");
      orin.holding = false;
      await line("ORIN", orin, "Relay 03. That's the lantern in the plaza. When it goes dark, every payment in town waits for it.");
      await line("ORIN", orin, "Go and relight it. Give the crystal a good knock. Gently. Firmly. Gently-firmly.");
      give("lens");
      setStage("relight");
    } else if (state.stage === "relight") {
      await line("ORIN", orin, "The plaza lantern, KAI. Gently-firmly.");
    } else if (state.stage === "backToOrin") {
      await line("ORIN", orin, "The lights! Now we can actually read the thing.");
      await line("ORIN", orin, "Hm. Hmmm. The payment wasn't lost. Look: somebody signed a block that replaced it.");
      await line("ORIN", orin, "Block 88. Signed by a node called... nothing. There's no such node in Blockhaven.");
      await line("ORIN", orin, "Take my findings to Maya. Sealed. If someone's rewriting blocks, I'd rather the whole plaza didn't hear it.");
      take("receipt");
      pay.logDelivery({ id: "receipt-4127", to: "orin-relay", note: "Courier KAI delivered pending receipt #4127 to Orin" });
      give("sealed");
      setStage("deliver");
    } else {
      await line("ORIN", orin, state.stage === "done" ? "A node with no name. I'll be listening to the relays tonight." : "Deliver it, courier! My tea's getting cold and so is the trail.");
    }
    if (!["toOrin", "backToOrin"].includes(at)) {
      const pick = await line("ORIN", orin, "Need parts? Fuses, tune-ups. My QR's on the board out front. Stablecoins welcome, they settle faster than my kettle boils.", {
        choices: [
          { label: "Scan the QR", value: "buy" },
          { label: "Not today", value: "no" },
        ],
      });
      if (pick === "buy") scanAfter = "orin-relay";
    }
  });
}

async function useRelay() {
  net.act("talk", "relay");
  busy = true;
  mover.enabled = false;
  try {
    if (state.relay) {
      await ui.say("RELAY 03", "The crystal hums softly. Confirmations are flowing again (simulated).");
    } else if (state.stage === "relight") {
      const pick = await ui.say("RELAY 03", "The crystal is cold and dark. A little plaque reads RELAY 03.", {
        choices: [
          { label: "Knock the crystal, gently-firmly", value: "knock" },
          { label: "Leave it", value: "leave" },
        ],
      });
      if (pick === "knock") {
        ui.closeDialogue();
        kai.cheer = 0.5;
        await wait(400);
        setRelay(true, true);
        await wait(700);
        await ui.say("KAI", "There we go. Hello, Relay 03.");
        ui.toast("Relay 03 is back online (simulated network)");
        setStage("backToOrin");
        // a glimpse of someone on the lookout
        echo.group.visible = true;
        setTimeout(() => state.stage !== "echo" && state.stage !== "done" && (echo.group.visible = false), 7000);
      }
    } else {
      await ui.say("RELAY 03", "The plaza's network lantern. It's dark. Maybe someone in town knows why.");
    }
  } finally {
    ui.closeDialogue();
    mover.enabled = true;
    busy = false;
  }
}

async function talkEcho() {
  await converse(echo, async () => {
    if (state.stage !== "echo") {
      await line("ECHO", echo, "...");
      return;
    }
    await line("ECHO", echo, "You relit one relay. Clever courier.");
    await line("ECHO", echo, "That block wasn't a glitch. Someone wanted Maya's payment to disappear, just to see if anyone would notice.");
    await line("ECHO", echo, "You noticed. Now they'll notice you.");
    await line("ECHO", echo, "Keep your satchel close, KAI. This was only the first block.");
  });
  particles.burst(echo.local(0, 1.2, 0), "spark", 50, 3);
  audio.zap();
  echo.group.visible = false;
  setStage("done");
  setTimeout(() => {
    audio.chime([0, 4, 7, 11, 12], 0.14);
    ui.chapterCard(
      () => {
        try {
          localStorage.removeItem("omen.save");
        } catch {
          /* ignore */
        }
        location.reload();
      },
      () => {},
    );
  }, 1200);
}

async function readBoard() {
  net.act("talk", "board");
  openForumAfter = false;
  busy = true;
  mover.enabled = false;
  try {
    const pick = await ui.say("NOTICE BOARD", "RELAY DOWN AGAIN?? ... LOST: 1 PAYMENT #4127 ... FESTIVAL TONIGHT ... and, pinned on top: COMMUNITY BOARD: ASK, SELL, CHAT.", {
      choices: [
        { label: "Open the community board", value: "forum" },
        { label: "Just reading", value: "no" },
      ],
    });
    if (pick === "forum") openForumAfter = true;
  } finally {
    ui.closeDialogue();
    mover.enabled = true;
    busy = false;
  }
  if (openForumAfter) community.openForum();
}
let openForumAfter = false;

function celebrate() {
  setFestival(true);
  audio.chime([0, 4, 7, 12, 16], 0.12);
  maya.cheer = 1.6;
  kai.cheer = 1.4;
  particles.burst(maya.local(0, 2.2, 0.8), "petal", 90, 5);
  particles.burst(mapDir(0, 0).multiplyScalar(R + 4), "petal", 120, 6);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ scan & pay: wallet, QR signs, payment journey

let scanAfter = null; // a conversation can end by sending KAI to a merchant's QR sign
const pay = initPay({
  onOpenChange(open) {
    clearHeldKeys();
    busy = open;
    mover.enabled = !open && mode === "play";
    input.x = input.y = 0;
    if (!open) payStatus(null);
  },
  onStage: (stage, co) => journey(stage, co),
});

// Painted QR signs on a post. The texture IS the merchant's UPI QR; scanning decodes its pixels.
const signs = {};
function qrSign(merchantId, building, local, faceLocal) {
  const canvas = pay.signCanvas(merchantId);
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.5, 8), toon(P.wood));
  post.position.y = 0.75;
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.86, 1.06, 0.06), toon(P.cream));
  board.position.set(0, 1.62, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: tex }));
  face.position.set(0, 1.68, 0.035);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.16, 0.07), toon(P.teal));
  cap.position.set(0, 2.2, 0);
  for (const m of [post, board, cap]) (m.castShadow = true), (m.receiveShadow = true);
  g.add(post, board, face, cap);
  building.add(g);
  g.position.copy(local);
  g.lookAt(building.localToWorld(faceLocal.clone()));
  g.updateMatrixWorld(true);
  const at = g.getWorldPosition(new THREE.Vector3());
  W.colliders.push({ dir: at.clone().normalize(), r: 0.35 });
  signs[merchantId] = { group: g, canvas, at, top: () => g.localToWorld(new THREE.Vector3(0, 2.45, 0)), front: () => g.localToWorld(new THREE.Vector3(0, 0, 1.1)) };
}
qrSign("maya-chai", W.hero.chai, new THREE.Vector3(2.35, 0, 3.6), new THREE.Vector3(2.35, 0, 12));
qrSign("orin-relay", W.hero.workshop, new THREE.Vector3(3.3, 0, 4.2), new THREE.Vector3(3.3, 0, 12));

// ------------------------------------------------------------------ storefronts players can claim

function signTexture(shop, label) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#fbf3e4";
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = shop ? "#" + SHOP_COLORS[shop.color].toString(16).padStart(6, "0") : "#d8c9ae";
  for (let x = 0; x < 512; x += 64) g.fillRect(x, 0, 32, 44); // awning stripes
  g.strokeStyle = "#2b2230";
  g.lineWidth = 10;
  g.strokeRect(5, 5, 502, 246);
  g.fillStyle = "#2b2230";
  g.textAlign = "center";
  g.font = "800 58px 'Bricolage Grotesque', system-ui, sans-serif";
  const fit = (t, size) => {
    let f = size;
    do g.font = `800 ${f}px 'Bricolage Grotesque', system-ui, sans-serif`;
    while (g.measureText(t).width > 470 && (f -= 4) > 20);
  };
  if (shop) {
    fit(shop.name, 60);
    g.fillText(shop.name, 256, 128);
    g.font = "32px 'Patrick Hand', cursive";
    g.fillText((shop.tagline || `run by ${shop.ownerName}`).slice(0, 34), 256, 190);
  } else {
    fit("FOR RENT", 72);
    g.fillText("FOR RENT", 256, 134);
    g.font = "34px 'Patrick Hand', cursive";
    g.fillText(`${label}: claim it, sell here`, 256, 196);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// The plaza's relay lantern is solid: the camera pulls in before it instead of looking through its
// pole (stalls face the plaza, which put the camera right behind it).
{
  let relayRoot = W.crystal;
  while (relayRoot.parent && relayRoot.parent !== scene) relayRoot = relayRoot.parent;
  if (!W.camBlockers.includes(relayRoot)) W.camBlockers.push(relayRoot);
}
const stalls = {};
for (const pl of PLOTS) {
  if (!pl.existing) {
    const m = model("market_stall");
    placeMap(m, pl.at[0], pl.at[1], pl.face[0], pl.face[1]);
    m.traverse((o) => o.isMesh && ((o.castShadow = true), (o.receiveShadow = true)));
    scene.add(m);
    W.colliders.push({ dir: mapDir(pl.at[0], pl.at[1]), r: 1.4 });
    W.camBlockers.push(m); // the camera pulls in front of stalls instead of looking through them
  }
  // a hanging sign in front of the stall, facing the lane
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 2.3, 8), toon(P.wood));
  post.position.set(-0.95, 1.15, 0);
  const post2 = post.clone();
  post2.position.x = 0.95;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.95), new THREE.MeshBasicMaterial({ map: signTexture(null, pl.label) }));
  board.position.set(0, 1.85, 0.02);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.98, 1.03, 0.05), toon(P.wood));
  back.position.set(0, 1.85, -0.02);
  g.add(post, post2, back, board);
  const at = mapDir(pl.at[0], pl.at[1]);
  const toward = mapDir(pl.face[0], pl.face[1]);
  const fwd = tangentToward(at, toward);
  const spot = at.clone().multiplyScalar(R).addScaledVector(fwd, 2.3);
  g.position.copy(spot);
  g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(at, fwd), at, fwd));
  scene.add(g);
  W.colliders.push({ dir: spot.clone().normalize(), r: 0.3 });
  W.camBlockers.push(g);
  stalls[pl.id] = { plot: pl, group: g, board, shop: null, front: () => g.localToWorld(new THREE.Vector3(0, 0, 1.2)), top: () => g.localToWorld(new THREE.Vector3(0, 2.6, 0)), local: (x, y, z) => g.localToWorld(new THREE.Vector3(x, y + 1.2, z)) };
}
function paintStalls(data) {
  for (const p of data.plots) {
    const st = stalls[p.plot];
    if (!st) continue;
    const key = JSON.stringify(p.shop ? [p.shop.name, p.shop.tagline, p.shop.color] : null);
    if (st.key === key) continue;
    st.key = key;
    st.shop = p.shop;
    st.board.material.map?.dispose();
    st.board.material.map = signTexture(p.shop, st.plot.label);
    st.board.material.needsUpdate = true;
  }
}

function startScan(merchantId) {
  net.act("scan", merchantId);
  const s = signs[merchantId];
  mover.face(s.at);
  particles.burst(s.top(), "spark", 14, 1.5);
  audio.chime([12, 16], 0.06);
  pay.startCheckout({ merchantId, sign: s.canvas });
}

// The in-world status chip ("Paying Maya · settling on Whitechain")
const chip = document.createElement("p");
chip.id = "pay-status";
chip.hidden = true;
chip.setAttribute("role", "status");
document.body.append(chip);
function payStatus(html) {
  chip.hidden = !html;
  if (html) chip.innerHTML = html;
}

function makeCoin() {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 20), new THREE.MeshBasicMaterial({ color: P.netGlow }));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 6, 20), new THREE.MeshBasicMaterial({ color: P.butter }));
  disc.rotation.x = Math.PI / 2;
  g.add(disc, rim);
  g.scale.setScalar(1.4);
  return g;
}
// Who the payment coin flies to: Orin, Maya, or a player's stall sign (which can't cheer, harmlessly).
const npcOf = (co) => {
  const m = co?.payment?.merchant || co?.merchant;
  if (m?.npc === "orin") return orin;
  if (m?.npc === "maya" || !m) return maya;
  return stalls[m.id] || maya;
};
const crystalPos = () => W.crystal.getWorldPosition(new THREE.Vector3());
let relayFlash = 0; // seconds the relay crystal glows for a payment (visual only, story state untouched)
let coinAt = null;

async function journey(stage, co) {
  const npc = npcOf(co);
  const p = co?.payment;
  const tag = p?.mode === "testnet" ? `<span class="badge real">TESTNET CRYPTO</span>` : p ? `<span class="badge demo">DEMO</span>` : "";
  const who = p?.merchant?.name || co?.merchant?.name || "merchant";
  if (stage === "scan") {
    kai.talk = 0;
    payStatus(`Scanning ${who}'s QR…`);
  } else if (stage === "quote") {
    payStatus(`${tag} Quote from the gateway…`);
  } else if (stage === "review") {
    payStatus(`${tag} Review the quote and safety check`);
  } else if (stage === "approve") {
    kai.holding = true;
    payStatus(`${tag} Waiting for your approval…`);
  } else if (stage === "settle") {
    // KAI's coin flies to the plaza relay: the network carrying the payment
    kai.holding = false;
    payStatus(`${tag} Settling ${p?.mode === "testnet" ? "on Whitechain Sepolia" : "DEMO credits"}…`);
    relayFlash = 4;
    const coin = new Envelope(scene);
    coin.mesh = makeCoin();
    const at = (coinAt = crystalPos().addScaledVector(crystalPos().normalize(), 0.6));
    audio.zap();
    await coin.fly(kai.local(0.3, 1.2, 0.3), at, { height: 5, duration: 1.3 });
    particles.burst(at, "spark", 40, 3); // `at`, not coinAt: the sheet may have closed meanwhile
  } else if (stage === "payout") {
    payStatus(`${tag} <span class="badge sim">DEMO INR SETTLEMENT</span> Quoted rupee equivalent for ${who} (no rupees move)…`);
    const coin = new Envelope(scene);
    coin.mesh = makeCoin();
    relayFlash = Math.max(relayFlash, 1.4);
    await coin.fly(coinAt || crystalPos(), npc.local(0.2, 1.3, 0.3), { height: 4, duration: 1.2 });
  } else if (stage === "done") {
    if (p?.merchant?.id) net.act("paid", p.merchant.id); // others see "X paid Maya": no amount, no address
    audio.chime([0, 4, 7, 12], 0.09);
    npc.cheer = 1.4;
    kai.cheer = 0.8;
    particles.burst(npc.local(0, 2.1, 0.6), npc === maya ? "petal" : "spark", npc === maya ? 60 : 40, 4);
    const inr = p ? `₹${(p.quote.inrPaise / 100).toFixed(2)}` : "";
    payStatus(`${tag} Paid ${who} · ${inr} quoted · DEMO INR SETTLEMENT`);
    const what = (p?.upi?.note || "").toLowerCase();
    ui.toast(npc === maya ? `Maya: “Paid! ${what ? `One ${what}` : "Your order"}, coming right up.”` : `Orin: “Received${what ? `: one ${what}` : ""}! Mind the cables on your way out.”`, 4200);
  } else if (stage === "fail") {
    kai.holding = false;
    payStatus(`${tag} Payment didn't go through. Nothing was charged unless a transaction is shown.`);
  } else if (stage === "arkiv") {
    particles.burst(kai.local(0, 2, 0), "spark", 24, 2);
    audio.chime([7, 12], 0.07);
    ui.toast("Receipt written to Arkiv by your wallet");
  } else if (stage === "close") {
    kai.holding = false;
    coinAt = null;
  }
}

addEventListener("keydown", (e) => {
  if ((e.key === "p" || e.key === "P") && mode === "play" && !busy && !ui.dialogueOpen() && !pay.isOpen() && !coinCard.isOpen()) pay.openWallet();
});

// ------------------------------------------------------------------ crypto discoveries

const coins = new Collectibles(scene, W.colliders);
const coinCard = createCoinCard({
  onOpenChange(open) {
    clearHeldKeys();
    busy = open;
    mover.enabled = !open && mode === "play";
    input.x = input.y = 0;
  },
});
let found = new Set();
const foundKey = () => `omen.coins.${coins.seed}`;
function placeCoins(seed) {
  coins.place(seed);
  try {
    found = new Set(JSON.parse(localStorage.getItem(foundKey()) || "[]"));
  } catch {
    found = new Set();
  }
}
function discover(it) {
  const first = !found.has(it.def.sym);
  if (first) {
    found.add(it.def.sym);
    try {
      localStorage.setItem(foundKey(), JSON.stringify([...found]));
    } catch {
      /* ignore */
    }
    it.burst = 1.2;
    particles.burst(it.group.position.clone(), "spark", 36, 3);
    audio.chime([0, 7, 12, 16], 0.07);
    kai.cheer = 0.9;
    net.act("coin", it.def.sym);
    ui.toast(`Discovered ${it.def.name}! (${found.size}/${coins.items.length}) · an educational collectible, not free crypto`, 4200);
  }
  mover.face(it.group.position);
  coinCard.open(it.def, { firstFind: first });
}

// ------------------------------------------------------------------ what can KAI interact with?

const relayPos = mapDir(0, 0).multiplyScalar(R);
const boardPos = W.colliders && mapDir(3.4, 4.3).multiplyScalar(R);
const talkables = [
  { label: "Talk to Maya", at: () => W.hero.chai.localToWorld(new THREE.Vector3(0.4, 0, 4.3)), head: () => headOf(maya), run: talkMaya, range: 2.8 },
  { label: "Talk to Orin", at: () => orin.local(0, 0, 1.6), head: () => headOf(orin), run: talkOrin, range: 2.6 },
  { label: "Talk to Alfred", at: () => alfred.local(0, 0, 1.5), head: () => headOf(alfred), run: async () => talkAlfred(), range: 2.8 },
  { label: "Talk to the stranger", at: () => echo.local(0, 0, 1.4), head: () => headOf(echo), run: talkEcho, range: 2.6, when: () => echo.group.visible },
  { get label() { return state.relay ? "Look at Relay 03" : "Examine Relay 03"; }, at: () => relayPos, head: () => relayPos.clone().addScaledVector(relayPos.clone().normalize(), 4.6), run: useRelay, range: 2.7 },
  { label: "Notice board · community", at: () => boardPos.clone().add(new THREE.Vector3()), head: () => boardPos.clone().addScaledVector(boardPos.clone().normalize(), 2.2), run: readBoard, range: 2.2 },
  { label: "Scan Maya's QR to pay", at: () => signs["maya-chai"].front(), head: () => signs["maya-chai"].top(), run: async () => startScan("maya-chai"), range: 1.8 },
  { label: "Scan Orin's QR to pay", at: () => signs["orin-relay"].front(), head: () => signs["orin-relay"].top(), run: async () => startScan("orin-relay"), range: 1.8 },
  // hoardings (community is created further down, so look it up lazily)
  ...BOARDS.map((bd, i) => ({
    get label() {
      return community.boards[i].shown ? `Look at the ${bd.label}` : `Advertise on the ${bd.label}`;
    },
    at: () => community.boards[i].front(),
    head: () => community.boards[i].top(),
    run: async () => community.openBoard(bd.id),
    range: 2.6,
  })),
  ...PLOTS.map((pl) => ({
    get label() {
      const st = stalls[pl.id];
      return !st.shop ? "Claim this stall" : st.shop.owner === shops.mine?.owner ? "Manage your stall" : `Browse ${st.shop.name}`;
    },
    at: () => stalls[pl.id].front(),
    head: () => stalls[pl.id].top(),
    run: async () => shops.openPlot(pl.id),
    range: 2.2,
  })),
  ...[0, 1, 2, 3, 4, 5].map((i) => ({
    get label() {
      const it = coins.items[i];
      return it ? (found.has(it.def.sym) ? `Look at ${it.def.name}` : `Discover ${it.def.name}`) : "";
    },
    when: () => !!coins.items[i],
    at: () => coins.groundAt(coins.items[i]),
    head: () => coins.headAt(coins.items[i]),
    run: async () => discover(coins.items[i]),
    range: 2.2,
  })),
];
let near = null;
function findNear() {
  const p = kai.group.position;
  let best = null;
  let bd = Infinity;
  for (const t of talkables) {
    if (t.when && !t.when()) continue;
    const d = t.at().distanceTo(p);
    if (d < t.range && d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}
async function act() {
  if (busy || mode !== "play" || !near) return;
  ui.prompt(null);
  scanAfter = null;
  await near.run();
  if (scanAfter) startScan(scanAfter);
  scanAfter = null;
}
bindInput(input, { onAct: act, onOrbit: (dx, dy) => (mode === "creator" ? (creatorYaw -= dx * 1.6) : rig.orbit(dx, dy)) });

// A small bobbing envelope over the current objective (subtle, not a beacon)
const marker = new Envelope(scene).mesh;
marker.scale.setScalar(0.9);
scene.add(marker);
function objectiveTarget() {
  switch (state.stage) {
    case "start":
    case "deliver":
      return headOf(maya).addScaledVector(maya.group.getWorldPosition(new THREE.Vector3()).normalize(), 0.9);
    case "toOrin":
    case "backToOrin":
      return headOf(orin).addScaledVector(orin.group.getWorldPosition(new THREE.Vector3()).normalize(), 0.9);
    case "relight":
      return relayPos.clone().addScaledVector(relayPos.clone().normalize(), 5.6);
    case "echo":
      return headOf(echo).addScaledVector(echo.group.position.clone().normalize(), 0.9);
    default:
      return null;
  }
}

// ------------------------------------------------------------------ title, intro, play

let mode = "title";
let swoop = null;
let titleT = 0;

function titleCam(t) {
  const a = t * 0.07 + 0.6;
  const pos = new THREE.Vector3(Math.sin(a) * 92, 62, Math.cos(a) * 92);
  camera.position.copy(pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 6, 0);
}

/** Avatar creator: a turntable around the courier, framed beside (wide) or above (narrow) the card. */
const creatorLook = new THREE.Vector3();
let creatorT = 0;
function creatorCam(dt) {
  creatorT += dt;
  // Face, eyes, hair and accessories: a close-up that sways gently around the front of the face.
  // Outfit and pet: the slow full-body turntable.
  const close = ["face", "eyes", "hair", "extras"].includes(creatorTab);
  if (close) creatorYaw = Math.sin(creatorT * 0.45) * 0.32;
  else creatorYaw += dt * 0.22;
  const p = kai.group.position;
  const up = p.clone().normalize();
  const f = mover.fwd.clone().applyAxisAngle(up, creatorYaw);
  const wide = innerWidth > 760;
  const right = new THREE.Vector3().crossVectors(up, f).normalize(); // camera's screen-right, looking back at KAI
  let pos;
  let look;
  if (close) {
    const head = kai.p.head.getWorldPosition(new THREE.Vector3());
    pos = head.clone().addScaledVector(up, 0.32).addScaledVector(f, wide ? 1.75 : 2.3);
    look = head.clone().addScaledVector(up, 0.24).addScaledVector(right, wide ? 0.52 : 0);
  } else {
    pos = p.clone().addScaledVector(up, wide ? 1.5 : 2.0).addScaledVector(f, wide ? 4.1 : 4.8);
    look = p.clone().addScaledVector(up, wide ? 0.9 : 0.35).addScaledVector(right, wide ? 1.25 : 0);
  }
  const k = 1 - Math.exp(-dt * 3.5);
  camera.position.lerp(pos, k);
  camera.up.lerp(up, k).normalize();
  creatorLook.lerp(look, k);
  camera.lookAt(creatorLook);
}

function startGame(fresh) {
  audio.start();

  if (fresh) {
    try {
      localStorage.removeItem("omen.save");
    } catch {
      /* ignore */
    }
  } else {
    const s = load();
    if (s) {
      Object.assign(state, { stage: s.stage, items: s.items || [], relay: !!s.relay, festival: !!s.festival });
      if (s.d && s.f) {
        mover.dir.fromArray(s.d).normalize();
        mover.fwd.fromArray(s.f);
        mover.apply();
      }
      setRelay(state.relay);
      setFestival(state.festival);
      if (state.stage === "echo") echo.group.visible = true;
    }
  }
  ui.setItems(state.items.map((i) => ITEMS[i]));
  rig.fwd.copy(mover.fwd);
  const to = rig.desired(mover);
  const fromLook = mode === "creator" ? creatorLook.clone() : new THREE.Vector3(0, 6, 0);
  if (reduceMotion) return beginPlay(fresh);
  mode = "swoop";
  swoop = { t: 0, from: { pos: camera.position.clone(), up: camera.up.clone(), look: fromLook }, to, fresh };
}

async function beginPlay(fresh) {
  mode = "play";
  rig.snap(mover);
  ui.showHud();
  ui.objective(STAGES[state.stage]);
  if (fresh) {
    busy = true;
    kai.talk = 1;
    await ui.say("KAI", "Morning, Blockhaven. Quiet streets, warm bread, and... the plaza relay flickering again.");
    await ui.say("KAI", "Only one delivery on the board today. 'See Maya. Urgent. Bring the satchel.'");
    kai.talk = 0;
    ui.closeDialogue();
    busy = false;
  }
  mover.enabled = true;
  save();
  pill.hidden = false; // solo players need the Invite button too
  // Everyone shares the public world unless they made a private room with friends.
  joinRoom(courier.room || PUBLIC_ROOM);
}

// ------------------------------------------------------------------ multiplayer

const PUBLIC_ROOM = "blockhaven";
const courier = { name: "", look: { ...DEFAULT_LOOK }, room: roomFromUrl() };
const kaiPet = {}; // holds KAI's pet (see avatar.js syncPet)
try {
  const saved = JSON.parse(localStorage.getItem("omen.courier") || "{}");
  courier.name = String(saved.name || "").slice(0, 16);
  courier.look = cleanLook(saved.look || lookFromOutfit(saved.outfit || 0)); // older saves only had an outfit
  const face = cleanFace(saved.look?.face); // the face (shared/face.js) is kept beside the look
  if (face) courier.look.face = face;
} catch {
  /* ignore */
}
const feedEl = Object.assign(document.createElement("ul"), { id: "feed" });
feedEl.setAttribute("aria-live", "polite");
document.body.append(feedEl);
function feed(text) {
  const li = document.createElement("li");
  li.textContent = text;
  feedEl.append(li);
  while (feedEl.children.length > 4) feedEl.firstChild.remove();
  setTimeout(() => li.classList.add("fade"), 5200);
  setTimeout(() => li.remove(), 5900);
}
const pill = Object.assign(document.createElement("div"), { id: "mp-pill", hidden: true });
pill.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="count"></span><span class="room"></span><button type="button">Invite</button>`;
document.getElementById("hud").append(pill);
pill.querySelector("button").onclick = async () => {
  if (!net.room) {
    courier.room = newRoomCode();
    history.replaceState(null, "", `?room=${courier.room}`);
    joinRoom(courier.room);
  }
  const url = inviteUrl(net.room);
  try {
    await navigator.clipboard.writeText(url);
    ui.toast(`Invite link copied: ${url}`, 5000);
  } catch {
    ui.toast(`Invite link: ${url}`, 8000);
  }
};
const net = createNet({
  scene,
  camera,
  feed,
  local: () => ({ d: mover.dir.toArray(), f: mover.fwd.toArray(), h: mover.h, sp: mover.speed, air: !mover.grounded, talk: kai.talk > 0, hold: !!kai.holding }),
  onCount: ({ room, online, connected }) => {
    pill.hidden = false;
    pill.classList.toggle("on", connected);
    pill.querySelector(".count").textContent = room ? `${online} online` : "Solo";
    pill.querySelector(".room").textContent = room === PUBLIC_ROOM ? "· public world" : room ? `· ${room}` : "";
  },
});
// ------------------------------------------------------------------ the market (player shops, B2B)

const shops = createShops({
  net,
  pay,
  toast: (t, ms) => ui.toast(t, ms),
  feed,
  chime: () => audio.chime([0, 7, 12], 0.08),
  myName: () => courier.name || "Courier",
  onOpenChange(open) {
    clearHeldKeys();
    busy = open;
    mover.enabled = !open && mode === "play";
    input.x = input.y = 0;
  },
  onShops: paintStalls,
});
const marketBtn = Object.assign(document.createElement("button"), { id: "market-btn", type: "button" });
marketBtn.setAttribute("aria-label", "Open the market (M)");
marketBtn.innerHTML = `<svg viewBox="0 0 48 40" aria-hidden="true"><path d="M5 15h38l-3-9H8z" fill="#B85C4A" stroke="#2B2230" stroke-width="2.6" stroke-linejoin="round"/><path d="M5 15c0 4 6 4 6 0 0 4 7 4 7 0 0 4 6 4 6 0 0 4 7 4 7 0 0 4 6 4 6 0 0 4 6 4 6 0" fill="#FBF3E4" stroke="#2B2230" stroke-width="2.4"/><rect x="9" y="20" width="30" height="16" fill="#F3D98B" stroke="#2B2230" stroke-width="2.6"/><rect x="20" y="25" width="8" height="11" fill="#8A5A3B" stroke="#2B2230" stroke-width="2.2"/></svg><span>Market</span>`;
marketBtn.onclick = () => !busy && shops.openDirectory();
document.getElementById("hud").append(marketBtn);
addEventListener("keydown", (e) => {
  if ((e.key === "m" || e.key === "M") && mode === "play" && !busy && !ui.dialogueOpen() && !e.target.closest?.("input, textarea, select")) shops.openDirectory();
});

// ------------------------------------------------------------------ community: forum, chat, billboards

const community = createCommunityUI({
  scene,
  camera,
  R,
  mapDir,
  tangentToward,
  toon,
  P,
  colliders: W.colliders,
  net,
  pay,
  ui,
  feed,
  chime: () => audio.chime([7, 12], 0.07),
  myName: () => courier.name || "Courier",
  myId: () => net.id,
  openShop: (id) => shops.openShop(id),
  myShop: () => shops.mine,
  canInteract: () => mode === "play" && !busy,
  onOpenChange(open) {
    clearHeldKeys();
    busy = open;
    mover.enabled = !open && mode === "play";
    input.x = input.y = 0;
  },
});
W.camBlockers.push(...community.boards.map((b) => b.group)); // the camera stops in front of hoardings
addEventListener("keydown", (e) => {
  if ((e.key === "t" || e.key === "T") && mode === "play" && !busy && !ui.dialogueOpen() && !e.target.closest?.("input, textarea, select")) {
    e.preventDefault();
    community.openChat();
  }
});

// ------------------------------------------------------------------ Alfred: advice, quests, guidance

const alfredUI = createAlfredUI({
  myName: () => courier.name || "Courier",
  context: () => ({ shop: shops.mine?.name || undefined, coins: found.size }),
  onOpenChange(open) {
    clearHeldKeys();
    busy = open;
    mover.enabled = !open && mode === "play";
    input.x = input.y = 0;
  },
  toast: (t, ms) => ui.toast(t, ms),
  chime: () => audio.chime([0, 7, 12], 0.08),
  blip: (p) => audio.blip(p),
  setTalking: (on) => {
    alfred.talk = on ? 1 : 0;
  },
  onComplete() {
    kai.cheer = 1.2;
    particles.burst(kai.local(0, 2.2, 0), "petal", 50, 4);
    setTimeout(() => give("alfredNote"), 1800); // after the "quest complete" toast has been read
  },
});
async function talkAlfred() {
  await converse(alfred, () => alfredUI.open({ managed: true }));
}

// A bobbing diamond marks the next step of the quest Alfred set; arriving there is detected here.
const questMarker = new THREE.Group();
questMarker.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial({ color: P.netGlow })), new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.03, 6, 24), new THREE.MeshBasicMaterial({ color: P.butter })));
questMarker.visible = false;
scene.add(questMarker);
const ARRIVE_RADIUS = 4.2;
const lookoutSpot = mapDir(...SPOTS.lookout).multiplyScalar(R);
/** Where a quest place is: `at` on the ground (for arrival), `mark` above it (for the marker). */
function placeInfo(place) {
  const from = kai.group.position;
  const up = (v, h) => v.clone().addScaledVector(v.clone().normalize(), h);
  const nearest = (list) => list.reduce((b, c) => (c.at.distanceTo(from) < b.at.distanceTo(from) ? c : b));
  switch (place) {
    case "maya": return { at: W.hero.chai.localToWorld(new THREE.Vector3(0.4, 0, 4.3)), mark: up(headOf(maya), 1) };
    case "orin": return { at: orin.local(0, 0, 1.6), mark: up(headOf(orin), 1) };
    case "relay": return { at: relayPos, mark: up(relayPos, 5.6) };
    case "board": return { at: boardPos, mark: up(boardPos, 3.2) };
    case "alfred": return { at: alfred.local(0, 0, 1.5), mark: up(headOf(alfred), 1) };
    case "lookout": return { at: lookoutSpot, mark: up(lookoutSpot, 3.4) };
    case "post": {
      const at = W.hero.post.localToWorld(new THREE.Vector3(0, 0, 5.5));
      return { at, mark: up(at, 5) };
    }
    case "market": return nearest(Object.values(stalls).map((st) => ({ at: st.front(), mark: up(st.top(), 0.7) })));
    case "hoarding": return nearest(community.boards.map((b) => ({ at: b.front(), mark: up(b.top(), 0.8) })));
    default: return null;
  }
}
let nextWave = 0;
function alfredFrame(dt, t) {
  if (mode !== "play") {
    questMarker.visible = false;
    alfredTag.hidden = true;
    return;
  }
  // Alfred notices the nearest courier (you or a remote player) and waves hello now and then
  if (!alfredUI.isOpen()) {
    let best = null;
    let bd = 9;
    for (const p of [kai.group.position, ...[...net.remotes.values()].map((r) => r.c.group.position)]) {
      const d = p.distanceTo(alfred.group.position);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (best) {
      const l = alfred.group.worldToLocal(best.clone());
      alfred.headTarget = THREE.MathUtils.clamp(Math.atan2(l.x, l.z), -0.9, 0.9);
    } else alfred.headTarget = 0;
    if (!busy && t > nextWave && kai.group.position.distanceTo(alfred.group.position) < 6) {
      alfred.wave = 1.4;
      nextWave = t + 60;
    }
  }
  // his name tag
  const head = alfred.local(0, 2.4, 0);
  const v = head.clone().project(camera);
  alfredTag.hidden = v.z > 1 || head.distanceTo(camera.position) > 32;
  if (!alfredTag.hidden) alfredTag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
  // quest guidance + arrival
  const qt = alfredUI.target();
  const info = qt && placeInfo(qt.place);
  questMarker.visible = !!info && !busy;
  if (!info) return;
  const up = info.mark.clone().normalize();
  questMarker.position.copy(info.mark).addScaledVector(up, Math.sin(t * 2.2) * 0.18);
  questMarker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  questMarker.rotateY(t * 1.6);
  if (!qt.step.arrived && info.at.distanceTo(kai.group.position) < ARRIVE_RADIUS && alfredUI.arrived(qt.place)) {
    ui.toast(`You've reached ${PLACE_SHORT[qt.place]}: ${qt.step.text}`, 5000);
    audio.chime([4, 9], 0.06);
  }
}

function joinRoom(room) {
  shops.refresh();
  community.refreshAds();
  if (coins.seed !== room) placeCoins(room);
  net.join({ room, name: courier.name || "Courier", look: courier.look });
}

// ------------------------------------------------------------------ landing + avatar creator

// [source, key, label, kind]: source "look" = shared/look.js, "face" = shared/face.js
const CREATOR_TABS = {
  face: [["face", "headWidth", "Face width", "chip"], ["face", "headLength", "Face length", "chip"], ["face", "jaw", "Jaw & chin", "chip"], ["face", "nose", "Nose", "chip"], ["face", "mouth", "Mouth", "chip"], ["face", "ears", "Ears", "chip"], ["look", "skin", "Skin", "color"]],
  eyes: [["face", "eyeSize", "Eye size", "chip"], ["face", "eyeSpacing", "Eye spacing", "chip"], ["face", "eyeColor", "Eye colour", "color"], ["face", "brows", "Eyebrows", "chip"]],
  hair: [["look", "hair", "Hair colour", "color"], ["face", "hairStyle", "Hairstyle", "chip"], ["look", "hairStyle", "At the back", "chip"], ["face", "facialHair", "Facial hair", "chip"]],
  outfit: [["look", "jacket", "Jacket", "color"], ["look", "pants", "Trousers", "color"], ["look", "scarf", "Scarf", "color"], ["look", "hat", "Hat", "chip"], ["look", "hatColor", "Hat colour", "color"], ["look", "body", "Build", "chip"]],
  extras: [["face", "glasses", "Glasses", "chip"], ["look", "accessory", "Accessory", "chip"]],
  pet: [["look", "pet", "Pet", "chip"]],
};
const OPTIONS = { look: LOOK_OPTIONS, face: FACE_OPTIONS };
const valueOf = (src, key) => (src === "face" ? (courier.look.face || DEFAULT_FACE)[key] : courier.look[key]);
/** Change one option. Face changes start from the current face (or the original courier's). */
function setOption(src, key, i) {
  if (src === "face") setLook({ ...courier.look, face: { ...(courier.look.face || DEFAULT_FACE), [key]: i } });
  else setLook({ ...courier.look, [key]: i });
}
const hex = (n) => "#" + n.toString(16).padStart(6, "0");
let creatorTab = "face";
let creatorYaw = 0;

function rememberCourier() {
  courier.name = document.getElementById("mp-name").value.trim().slice(0, 16);
  try {
    localStorage.setItem("omen.courier", JSON.stringify({ name: courier.name, look: courier.look }));
  } catch {
    /* ignore */
  }
}
function setLook(look) {
  courier.look = applyLook(kai, look);
  syncPet(scene, kaiPet, courier.look.pet);
  rememberCourier();
  if (mode === "play") net.setLook(courier.look);
}
function renderCreator() {
  const panel = document.getElementById("cr-panel");
  panel.innerHTML = CREATOR_TABS[creatorTab]
    .map(([src, key, label, kind]) => {
      const opts = OPTIONS[src][key]
        .map((o, i) => {
          const on = valueOf(src, key) === i;
          return kind === "color"
            ? `<button type="button" class="sw-btn" role="radio" aria-checked="${on}" aria-label="${o.name}" title="${o.name}" data-s="${src}" data-k="${key}" data-i="${i}" style="background:${hex(o.hex)}"></button>`
            : `<button type="button" class="chip" role="radio" aria-checked="${on}" data-s="${src}" data-k="${key}" data-i="${i}">${o.name}</button>`;
        })
        .join("");
      return `<div class="cr-row"><span class="cr-label" id="lbl-${src}-${key}">${label}</span><div class="cr-opts" role="radiogroup" aria-labelledby="lbl-${src}-${key}">${opts}</div></div>`;
    })
    .join("");
  document.querySelectorAll(".cr-tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === creatorTab)));
}
function openCreator(friends) {
  if (friends && !courier.room) {
    courier.room = newRoomCode();
    history.replaceState(null, "", `?room=${courier.room}`);
  }
  document.getElementById("title").hidden = true;
  document.getElementById("creator").hidden = false;
  document.getElementById("cr-over-wrap").hidden = !load();
  if (mode !== "creator") creatorLook.set(0, 6, 0); // ease in from where the landing camera looks
  mode = "creator";
  creatorYaw = 0;
  renderCreator();
  document.getElementById("mp-name").focus();
}
function leaveCreatorAndPlay() {
  rememberCourier();
  const hasSave = !!load();
  ui.hideTitle();
  startGame(!hasSave || document.getElementById("cr-over").checked);
}
{
  document.getElementById("mp-name").value = courier.name || "";
  document.getElementById("mp-name").addEventListener("input", rememberCourier);
  document.getElementById("cr-panel").addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]");
    if (!b) return;
    setOption(b.dataset.s, b.dataset.k, Number(b.dataset.i));
    kai.wave = 0.6;
    renderCreator();
    document.querySelector(`[data-s="${b.dataset.s}"][data-k="${b.dataset.k}"][data-i="${b.dataset.i}"]`)?.focus();
  });
  document.getElementById("cr-panel").addEventListener("keydown", (e) => {
    const b = e.target.closest("[data-k]");
    if (!b || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const n = OPTIONS[b.dataset.s][b.dataset.k].length;
    const i = (Number(b.dataset.i) + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    setOption(b.dataset.s, b.dataset.k, i);
    renderCreator();
    document.querySelector(`[data-s="${b.dataset.s}"][data-k="${b.dataset.k}"][data-i="${i}"]`)?.focus();
  });
  document.querySelector(".cr-tabs").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (!t) return;
    creatorTab = t.dataset.tab;
    renderCreator();
  });
  document.getElementById("cr-random").onclick = () => {
    // only when asked: shuffle clothes and colours, never the face someone built from their photo
    setLook({ ...randomLook(), ...(courier.look.face ? { face: courier.look.face } : {}) });
    kai.cheer = 0.8;
    renderCreator();
  };

  // ---- selfie → likeness, manual editing, save / regenerate / reset, World ID
  let generated = null; // the selfie result (option indices only), for "Regenerate from selfie"
  try {
    const g = JSON.parse(localStorage.getItem("omen.face.generated") || "null");
    if (g?.face) generated = { face: cleanFace(g.face), colours: g.colours || {} };
  } catch {
    /* ignore */
  }
  const regen = document.getElementById("cr-regen");
  const applyGenerated = () => {
    const c = generated.colours;
    setLook({
      ...courier.look,
      ...(c.skin !== undefined ? { skin: c.skin } : {}),
      ...(c.hair !== undefined ? { hair: c.hair } : {}),
      ...(courier.look.hat === 0 ? { hat: 1 } : {}), // the courier cap would hide the hair the photo suggested
      ...(c.longHair ? { hairStyle: 1 } : {}), // long at the back
      face: { ...generated.face, ...(c.eyeColor !== undefined ? { eyeColor: c.eyeColor } : {}), ...(c.longHair ? { hairStyle: 6 } : {}) },
    });
    creatorTab = "face";
    renderCreator();
    kai.cheer = 1;
  };
  regen.disabled = !generated;
  const selfie = createSelfie({
    toast: (t, ms) => ui.toast(t, ms),
    onApply(r) {
      generated = { face: r.face, colours: r.colours };
      try {
        localStorage.setItem("omen.face.generated", JSON.stringify(generated)); // indices only, never the photo
      } catch {
        /* ignore */
      }
      regen.disabled = false;
      applyGenerated();
      ui.toast("Here's your likeness. Fine-tune anything in the Face, Eyes and Hair tabs.", 5000);
    },
  });
  document.getElementById("cr-selfie").onclick = () => selfie.open("camera");
  document.getElementById("cr-photo").onclick = () => selfie.open("upload");
  document.getElementById("cr-manual").onclick = () => {
    if (!courier.look.face) setLook({ ...courier.look, face: { ...DEFAULT_FACE, brows: 1, mouth: 2, ears: 2 } });
    creatorTab = "face";
    renderCreator();
    document.querySelector("#cr-panel [data-k]")?.focus();
  };
  document.getElementById("cr-skip").onclick = leaveCreatorAndPlay;
  regen.onclick = () => generated && applyGenerated();
  document.getElementById("cr-reset").onclick = () => {
    if (!confirm("Reset your courier to the original look? (Your saved selfie result stays available under Regenerate.)")) return;
    setLook({ ...DEFAULT_LOOK });
    renderCreator();
  };

  let who = { state: "unavailable" };
  let account = null; // the World ID account's avatar { id, revision } when signed in
  const faceKey = () => (account ? `omen.face.${account.id}` : null);
  async function refreshIdentity() {
    who = await worldId.identity();
    document.getElementById("cr-id").innerHTML = worldId.badge(who);
    const btn = document.getElementById("cr-world");
    btn.hidden = !((who.state === "guest" && who.configured) || who.state === "expired");
    btn.textContent = who.state === "expired" ? "Sign in again" : "Verify with World ID";
    const out = document.getElementById("cr-signout");
    out.hidden = !["verified", "world-unverified", "expired"].includes(who.state);
    out.textContent = who.state === "expired" ? "Continue as guest" : "Sign out";
    if (who.state === "expired" || who.state === "guest") account = null;
    if (who.state === "verified" || who.state === "world-unverified") {
      try {
        const a = await worldId.loadAvatar();
        account = { id: a.id, revision: a.revision };
        let face = null;
        try {
          face = cleanFace(JSON.parse(localStorage.getItem(faceKey()) || "null"));
        } catch {
          /* ignore */
        }
        courier.name = a.displayName || courier.name;
        document.getElementById("mp-name").value = courier.name;
        setLook({ ...a.look, ...(face ? { face } : {}) });
        renderCreator();
      } catch {
        /* keep the local look */
      }
    }
  }
  document.getElementById("cr-world").onclick = async (e) => {
    e.target.disabled = true;
    try {
      await worldId.signIn();
    } catch (err) {
      ui.toast(`World ID sign-in isn't available right now (${err.message}). You can keep playing as a guest.`, 5000);
      e.target.disabled = false;
    }
  };
  document.getElementById("cr-signout").onclick = async () => {
    try {
      await worldId.signOut();
    } catch {
      /* the cookie is cleared either way */
    }
    location.replace(location.pathname + location.search); // reconnects /world with the guest identity
  };
  document.getElementById("cr-save").onclick = async () => {
    rememberCourier();
    if (account) {
      const { face, ...base } = courier.look;
      try {
        const a = await worldId.saveAvatar(courier.name.length >= 2 ? courier.name : undefined, base, account.revision);
        account.revision = a.revision;
        if (face) localStorage.setItem(faceKey(), JSON.stringify(face));
        ui.toast("Avatar saved to your World ID account.", 3500);
      } catch (err) {
        ui.toast(err.code === "avatar_conflict" ? "Your avatar changed on another device. Reloading it…" : `Couldn't save to your account (${err.message}). It's saved on this device.`, 5000);
        if (err.code === "avatar_conflict") refreshIdentity();
      }
    } else ui.toast("Avatar saved on this device. Verify with World ID to keep it with your account.", 4000);
    kai.cheer = 1;
  };
  if (new URLSearchParams(location.search).get("world_id") === "success") {
    const u = new URL(location.href);
    u.searchParams.delete("world_id");
    history.replaceState(null, "", u.pathname + u.search);
    ui.toast("Signed in with World ID.", 3500);
  }
  refreshIdentity();
  window.__omenAvatar = { selfie, refreshIdentity, identity: () => who }; // test hook
  document.getElementById("cr-back").onclick = () => {
    document.getElementById("creator").hidden = true;
    document.getElementById("title").hidden = false;
    mode = "title";
  };
  document.getElementById("start").onclick = leaveCreatorAndPlay;
  document.getElementById("wallet-play").onclick = async (e) => {
    e.target.disabled = true;
    try {
      await pay._wallet.connect();
      ui.toast("Wallet connected: you can pay with testnet USDT in the world.");
    } catch (err) {
      ui.toast(err.shortMessage || err.message, 5000);
      e.target.disabled = false;
      return;
    }
    leaveCreatorAndPlay();
  };
  const roomNote = document.getElementById("mp-room");
  if (courier.room) {
    roomNote.hidden = false;
    roomNote.querySelector("b").textContent = courier.room;
    document.getElementById("friends").hidden = true;
  }
  setLook(courier.look);
}

// ------------------------------------------------------------------ loop

const clock = new THREE.Clock();
const lightDir = new THREE.Vector3();
let saveT = 0;

function frame() {
  const raw = clock.getDelta();
  const dt = Math.min(raw, 0.1); // real-time down to 10 fps; beyond that, slow down rather than tunnel
  perf.frame(raw);
  const t = clock.elapsedTime;

  if (mode === "title") {
    titleT += dt;
    titleCam(titleT);
  } else if (mode === "creator") {
    creatorCam(dt);
  } else if (mode === "swoop") {
    swoop.t = Math.min(1, swoop.t + dt / 2.8);
    const e = 1 - Math.pow(1 - swoop.t, 3);
    camera.position.lerpVectors(swoop.from.pos, swoop.to.pos, e);
    camera.up.lerpVectors(swoop.from.up, swoop.to.up, e).normalize();
    camera.lookAt(new THREE.Vector3().lerpVectors(swoop.from.look, swoop.to.look, e));
    if (swoop.t >= 1) beginPlay(swoop.fresh);
  } else {
    mover.update(dt, input, rig.fwd);
    rig.update(mover, dt);
    if (!busy && !ui.dialogueOpen()) {
      near = findNear();
      ui.prompt(near ? near.label : null, near ? near.head() : null, camera);
    } else ui.prompt(null);
    saveT += dt;
    if (saveT > 4) {
      saveT = 0;
      save();
    }
  }

  kai.update(dt, t);
  kaiPet.pet?.update(dt, kai.group, mover.speed);
  if (mode === "play") net.update(dt, t);
  coins.update(dt, t, found);
  alfredFrame(dt, t);
  community.update((id) => (id === net.id ? headOf(kai).addScaledVector(kai.group.position.clone().normalize(), 0.75) : net.remotes.get(id)?.c.local(0, 2.55, 0)));
  maya.update(dt, t);
  orin.update(dt, t);
  alfred.update(dt, t);
  if (echo.group.visible) echo.update(dt, t);
  for (const e of flying) e.update(dt);
  particles.update(dt);
  smoke.update(dt);
  birds.update(dt, t);

  // the objective marker bobs above whoever you're looking for
  const target = mode === "play" ? objectiveTarget() : null;
  marker.visible = !!target && !busy;
  if (target) {
    const up = target.clone().normalize();
    marker.position.copy(target).addScaledVector(up, Math.sin(t * 2.4) * 0.15);
    marker.up.copy(up);
    marker.lookAt(marker.position.clone().add(camera.position.clone().sub(marker.position).projectOnPlane(up)));
    marker.rotateX(-Math.PI / 2.4);
  }
  // relay crystal pulses when it's alive
  if (relayFlash > 0) {
    relayFlash -= dt;
    const m = W.crystal.material;
    if (relayFlash > 0) {
      m.color.set(P.netGlow);
      m.emissive.set(P.netGlow);
      m.emissiveIntensity = 1.4 + Math.sin(t * 14) * 0.6;
    } else setRelay(state.relay); // back to whatever the story says
  } else if (state.relay) W.crystal.material.emissiveIntensity = 1.1 + Math.sin(t * 3) * 0.35;
  W.crystal.rotation.y += dt * (relayFlash > 0 ? 4 : state.relay ? 1.2 : 0.1);

  // light from over the viewer's shoulder; shadows follow KAI
  const up = mode === "play" ? mover.dir : camera.up;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const back = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
  lightDir.copy(up).addScaledVector(right, 0.75).addScaledVector(back, 0.25).normalize();
  const focus = mode === "title" ? new THREE.Vector3(0, R, 0) : kai.group.position;
  if (mode === "title") lightDir.copy(camera.position).normalize().add(new THREE.Vector3(0.4, 0.8, 0)).normalize();
  sun.position.copy(focus).addScaledVector(lightDir, 40);
  sun.target.position.copy(focus);
  sun.shadow.camera.updateProjectionMatrix();
  W.sky.material.uniforms.uUp.value.copy(mode === "title" ? new THREE.Vector3(0, 1, 0) : up);
  W.sky.material.uniforms.uTime.value = t;

  ink.render(scene, camera, t, [W.sky]);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
ui.hideLoading();
ui.showTitle(!!load(), {
  onJoin: (friends) => openCreator(friends),
  onContinue: () => {
    rememberCourier();
    ui.hideTitle();
    startGame(false);
  },
});

// Test hook for automated playtests
window.__omen = {
  state,
  mover,
  rig,
  kai,
  maya,
  orin,
  echo,
  talkables,
  W,
  pay,
  signs,
  startScan,
  camera,
  ui,
  net,
  courier,
  coins,
  coinCard,
  perf,
  stalls,
  shops,
  community,
  alfred,
  alfredUI,
  THREE, // test hook only: lets browser tests raycast the real scene
  Character, // test hooks: build a second courier from a look, as another player would see it
  applyLook,
  scene,
  get mode() {
    return mode;
  },
  stand(worldPos, faceWorld) {
    mover.dir.copy(worldPos).normalize();
    mover.fwd.copy(tangentToward(mover.dir, faceWorld.clone().normalize()));
    mover.apply();
    rig.fwd.copy(mover.fwd);
    rig.snap(mover);
  },
  teleport(x, z, fx, fz) {
    mover.dir.copy(mapDir(x, z));
    mover.fwd.copy(tangentToward(mover.dir, mapDir(fx, fz)));
    mover.apply();
    rig.snap(mover);
  },
};
