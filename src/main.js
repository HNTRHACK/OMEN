import * as THREE from "three";
import { P, R } from "./palette.js";
import { loadAll } from "./assets.js";
import { buildWorld } from "./world.js";
import { mapDir, tangentToward } from "./planet.js";
import { SPOTS } from "./layout.js";
import { Character } from "./character.js";
import { Mover, CameraRig } from "./player.js";
import { InkPass } from "./post.js";
import { Envelope, Particles, Smoke, Birds, flying } from "./fx.js";
import { ui, bindInput } from "./ui.js";
import { audio } from "./audio.js";
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
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  ink.setSize(innerWidth, innerHeight, PR);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = innerWidth < innerHeight ? 62 : 50;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

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

const kai = new Character("kai");
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
    const s = JSON.parse(localStorage.getItem("omen.save") || "null");

    if (!s || typeof s !== "object" || Array.isArray(s)) return null;

    if (
      typeof s.stage !== "string" ||
      !Object.hasOwn(STAGES, s.stage)
    ) {
      return null;
    }

    if (
      !Array.isArray(s.items) ||
      !s.items.every(
        (id) => typeof id === "string" && Object.hasOwn(ITEMS, id),
      )
    ) {
      return null;
    }

    if (
      typeof s.relay !== "boolean" ||
      typeof s.festival !== "boolean"
    ) {
      return null;
    }

    // Accept only finite, nonzero three-dimensional vectors.
    const unit = (v) => {
      if (
        !Array.isArray(v) ||
        v.length !== 3 ||
        !v.every(Number.isFinite)
      ) {
        return null;
      }

      const length = Math.hypot(...v);
      if (!Number.isFinite(length) || length < 1e-8) return null;

      return v.map((n) => n / length);
    };

    const d = unit(s.d);
    const facing = unit(s.f);
    if (!d || !facing) return null;

    // Keep the facing direction tangent to the planet.
    const dot = d.reduce((sum, n, i) => sum + n * facing[i], 0);
    const f = unit(facing.map((n, i) => n - dot * d[i]));
    if (!f) return null;

    return {
      stage: s.stage,
      items: [...new Set(s.items)],
      relay: s.relay,
      festival: s.festival,
      d,
      f,
    };
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
        done: "The kettle's on. It's always on, for you.",
      };
      await line("MAYA", maya, lines[state.stage] || lines.done);
    }
  });
}

async function talkOrin() {
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
      give("sealed");
      setStage("deliver");
    } else {
      await line("ORIN", orin, state.stage === "done" ? "A node with no name. I'll be listening to the relays tonight." : "Deliver it, courier! My tea's getting cold and so is the trail.");
    }
  });
}

async function useRelay() {
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
  const completesChapter = state.stage === "echo";
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
  if (!completesChapter) return;
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
      () => { },
    );
  }, 1200);
}

async function readBoard() {
  busy = true;
  mover.enabled = false;
  try {
    await ui.say("NOTICE BOARD", "RELAY DOWN AGAIN?? ... LOST: 1 PAYMENT #4127 ... FESTIVAL TONIGHT ... and, in very small writing: WHO SIGNED BLOCK 88?");
  } finally {
    ui.closeDialogue();
    mover.enabled = true;
    busy = false;
  }
}

function celebrate() {
  setFestival(true);
  audio.chime([0, 4, 7, 12, 16], 0.12);
  maya.cheer = 1.6;
  kai.cheer = 1.4;
  particles.burst(maya.local(0, 2.2, 0.8), "petal", 90, 5);
  particles.burst(mapDir(0, 0).multiplyScalar(R + 4), "petal", 120, 6);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ what can KAI interact with?

const relayPos = mapDir(0, 0).multiplyScalar(R);
const boardPos = W.colliders && mapDir(3.4, 4.3).multiplyScalar(R);
const talkables = [
  { label: "Talk to Maya", at: () => W.hero.chai.localToWorld(new THREE.Vector3(0.4, 0, 4.3)), head: () => headOf(maya), run: talkMaya, range: 2.8 },
  { label: "Talk to Orin", at: () => orin.local(0, 0, 1.6), head: () => headOf(orin), run: talkOrin, range: 2.6 },
  { label: "Talk to the stranger", at: () => echo.local(0, 0, 1.4), head: () => headOf(echo), run: talkEcho, range: 2.6, when: () => echo.group.visible },
  { get label() { return state.relay ? "Look at Relay 03" : "Examine Relay 03"; }, at: () => relayPos, head: () => relayPos.clone().addScaledVector(relayPos.clone().normalize(), 4.6), run: useRelay, range: 2.7 },
  { label: "Read the notice board", at: () => boardPos.clone().add(new THREE.Vector3()), head: () => boardPos.clone().addScaledVector(boardPos.clone().normalize(), 2.2), run: readBoard, range: 2.2 },
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
  await near.run();
}
bindInput(input, { onAct: act, onOrbit: (dx, dy) => rig.orbit(dx, dy) });

// The large blue arrow marks the current objective.
const objectiveArrow = new THREE.Group();
const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0x168cff, toneMapped: false });
const arrowShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 8), arrowMaterial);
arrowShaft.position.y = 0.8;
const arrowHead = new THREE.Mesh(new THREE.ConeGeometry(0.58, 0.9, 6), arrowMaterial);
arrowHead.rotation.z = Math.PI;
arrowHead.position.y = 0.1;
objectiveArrow.add(arrowShaft, arrowHead);
scene.add(objectiveArrow);
const objectiveUp = new THREE.Vector3();
const objectiveRotation = new THREE.Quaternion();
function roofTarget(building, height) {
  const position = building.getWorldPosition(new THREE.Vector3());
  building.getWorldQuaternion(objectiveRotation);
  objectiveUp.set(0, 1, 0).applyQuaternion(objectiveRotation).normalize();
  return position.addScaledVector(objectiveUp, height);
}
function objectiveTarget() {
  switch (state.stage) {
    case "start":
    case "deliver":
      return roofTarget(W.hero.chai, 7.2);
    case "toOrin":
    case "backToOrin":
      return roofTarget(W.hero.workshop, 7.2);
    case "relight":
      return relayPos.clone().addScaledVector(relayPos.clone().normalize(), 5.6);
    case "echo":
      return echo.group.position.clone().normalize().multiplyScalar(R + 1.4);
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
  if (reduceMotion) return beginPlay(fresh);
  mode = "swoop";
  swoop = { t: 0, from: { pos: camera.position.clone(), up: camera.up.clone(), look: new THREE.Vector3(0, 6, 0) }, to, fresh };
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
}

// ------------------------------------------------------------------ loop

const clock = new THREE.Clock();
const lightDir = new THREE.Vector3();
let saveT = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (mode === "title") {
    titleT += dt;
    titleCam(titleT);
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
  maya.update(dt, t);
  orin.update(dt, t);
  if (echo.group.visible) echo.update(dt, t);
  for (const e of flying) e.update(dt);
  particles.update(dt);
  smoke.update(dt);
  birds.update(dt, t);

  // Keep the original blue objective arrow hovering above the destination roof.
  const target = mode === "play" ? objectiveTarget() : null;
  objectiveArrow.visible = !!target && !busy;
  if (target) {
    const up = target.clone().normalize();
    objectiveArrow.position.copy(target).addScaledVector(up, 3.1 + Math.sin(t * 2.4) * 0.18);
    objectiveArrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  }
  // relay crystal pulses when it's alive
  if (state.relay) W.crystal.material.emissiveIntensity = 1.1 + Math.sin(t * 3) * 0.35;
  W.crystal.rotation.y += dt * (state.relay ? 1.2 : 0.1);

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
ui.showTitle(!!load(), startGame);

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
