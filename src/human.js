// OMEN's player character: an original stylised human (tools/blender/humanoid*.py → human.glb)
// with a real skeleton and animation clips, driven like the old Character (same fields: group,
// speed, air, talk, wave, cheer, holding, squash, stepCb, update(), local(), p.head), so the
// player, other players and both worlds swap it in without new plumbing.
//
// Animation: locomotion clips (idle, walk, run, turn, fall) are split into LOWER and UPPER body
// halves; gestures (wave, talk, interact, hold) play on the upper half only and take it over
// while active, so a player can wave or talk while walking. Walk/run playback rate follows the
// real ground speed (stride lengths below) so the feet don't slide.
import * as THREE from "three";
import { skinnedModel, clips, toon } from "./assets.js";
import { P } from "./palette.js";
import { LOOK_OPTIONS as O, cleanLook } from "../shared/look.js";
import { FACE_OPTIONS as F, cleanFace } from "../shared/face.js";

export const HUMAN_SCALE = 0.9; // about 1.7 m tall, hair included
// Metres travelled per clip cycle at timeScale 1 (measured from the clips' leg swing: see
// tools/blender/humanoid_rig.py; checked in e2e/humanoid.mjs by foot-slide measurement).
export const WALK_STRIDE = 1.3 * HUMAN_SCALE;
export const RUN_STRIDE = 2.25 * HUMAN_SCALE;
const LOWER = new Set(["hips", "thigh_L", "shin_L", "foot_L", "thigh_R", "shin_R", "foot_R"]);
const LOCO = ["idle", "walk", "run", "turn", "fall"];
const GESTURES = ["wave", "talk", "interact"];
const ss = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const damp = (cur, target, k) => cur + (target - cur) * k;

function split(clip, lower) {
  const keep = (tr) => LOWER.has(tr.name.split(".")[0]) === lower;
  return new THREE.AnimationClip(`${clip.name}_${lower ? "lower" : "upper"}`, clip.duration, clip.tracks.filter(keep));
}

export class Human {
  constructor({ unique = true } = {}) {
    this.isHuman = true;
    this.group = new THREE.Group();
    this.rig = skinnedModel("human", { uniqueMaterials: unique });
    this.rig.scale.setScalar(HUMAN_SCALE);
    this.group.add(this.rig);
    this.bones = {};
    this.meshes = {};
    this.rig.traverse((o) => {
      if (o.isBone) this.bones[o.name] = o;
      if (o.isMesh) {
        this.meshes[o.name] = o;
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.isSkinnedMesh) o.frustumCulled = false; // its bind-pose bounds don't follow the animation
      }
    });
    this.p = { head: this.bones.head, body: this.bones.chest, handR: this.bones.hand_R, handL: this.bones.hand_L };
    this.mixer = new THREE.AnimationMixer(this.rig);
    const byName = Object.fromEntries(clips("human").map((c) => [c.name, c]));
    this.a = {};
    for (const n of LOCO) {
      for (const half of ["lower", "upper"]) {
        const act = this.mixer.clipAction(split(byName[n], half === "lower"));
        act.play();
        act.setEffectiveWeight(n === "idle" ? 1 : 0);
        this.a[`${n}_${half}`] = act;
      }
    }
    for (const n of [...GESTURES]) {
      const act = this.mixer.clipAction(split(byName[n], false));
      act.setLoop(n === "talk" ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      act.clampWhenFinished = n !== "talk";
      act.enabled = true;
      this.a[n] = act;
    }
    // the hold pose: the interact reach, frozen part-way
    this.a.hold = this.mixer.clipAction(split(byName.interact, false).clone());
    this.a.hold.play();
    this.a.hold.paused = true;
    this.a.hold.time = byName.interact.duration * 0.35;
    this.a.hold.setEffectiveWeight(0);
    for (const n of ["jump", "land"]) {
      for (const half of ["lower", "upper"]) {
        const act = this.mixer.clipAction(split(byName[n], half === "lower"));
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
        this.a[`${n}_${half}`] = act;
      }
    }
    this.dur = Object.fromEntries(Object.entries(byName).map(([k, c]) => [k, c.duration]));
    this.speed = 0;
    this.air = false;
    this.talk = 0;
    this.wave = 0;
    this.cheer = 0;
    this.holding = false;
    this.squash = 0;
    this.stepCb = null;
    this.headYaw = 0;
    this._w = { idle: 1, walk: 0, run: 0, turn: 0, fall: 0 };
    this._gesture = 0; // upper-body takeover weight
    this._air = 0;
    this._airT = 0;
    this._land = 0;
    this._turn = 0;
    this._q = new THREE.Quaternion();
    this._phase = 0;
    this._lastStep = 0;
    this._waving = false;
    this._interact = 0;
  }

  get baseScale() {
    if (!this._bs) this._bs = new THREE.Vector3(1, 1, 1);
    return this._bs;
  }

  /** World position of a point in the character's local space (e.g. above the head). */
  local(x, y, z) {
    return this.group.localToWorld(new THREE.Vector3(x, y, z));
  }

  /** Reach out to a stall / counter (played on the upper body). */
  interact() {
    const a = this.a.interact;
    a.reset().setEffectiveWeight(1).play();
    this._interact = this.dur.interact;
  }

  update(dt, t) {
    // how fast the character is turning (for the step-in-place turn clip)
    const q = this.group.quaternion;
    const ang = this._q.angleTo(q);
    this._q.copy(q);
    this._turn = damp(this._turn, dt > 0 ? ang / dt : 0, Math.min(1, dt * 8));

    // airborne: spring (jump) then fall; land when back down after a real flight
    if (this.air && this._air === 0) {
      this._airT = 0;
      for (const h of ["lower", "upper"]) this.a[`jump_${h}`].reset().setEffectiveWeight(1).play();
    }
    if (!this.air && this._air > 0 && this._airT > 0.22) {
      for (const h of ["lower", "upper"]) this.a[`land_${h}`].reset().setEffectiveWeight(1).play();
      this._land = this.dur.land;
    }
    this._air = this.air ? 1 : 0;
    if (this.air) this._airT += dt;
    this._land = Math.max(0, this._land - dt);
    const jumping = this.air && this._airT < this.dur.jump;
    const jumpW = this.air ? (jumping ? 1 : Math.max(0, 1 - (this._airT - this.dur.jump) * 6)) : 0;
    const landW = this._land > 0 ? Math.min(1, this._land / 0.12) : 0;
    for (const h of ["lower", "upper"]) {
      this.a[`jump_${h}`].setEffectiveWeight(jumpW);
      this.a[`land_${h}`].setEffectiveWeight(landW);
    }

    // locomotion weights from speed
    const s = this.speed;
    const k = Math.min(1, dt * 10);
    const run = ss(3.9, 5.4, s);
    const walk = ss(0.12, 0.9, s) * (1 - run);
    const turn = !this.air && s < 0.3 ? ss(0.9, 2.2, this._turn) : 0;
    const want = { walk, run, turn, fall: this.air ? 1 : 0, idle: 0 };
    want.idle = Math.max(0, 1 - walk - run - turn);
    const ground = (1 - jumpW) * (1 - landW);
    if (this.air) for (const n of ["idle", "walk", "run", "turn"]) want[n] = 0;
    for (const n of LOCO) this._w[n] = damp(this._w[n], want[n], k);
    // playback rate follows the ground speed (no sliding feet)
    const walkRate = Math.max(0.55, s / WALK_STRIDE) * this.dur.walk;
    const runRate = Math.max(0.6, s / RUN_STRIDE) * this.dur.run;
    for (const h of ["lower", "upper"]) {
      this.a[`walk_${h}`].timeScale = walkRate;
      this.a[`run_${h}`].timeScale = runRate;
    }
    // keep walk and run in step so blending between them doesn't scissor the legs
    const ph = (this.a.walk_lower.time / this.dur.walk) % 1;
    if (this._w.run > 0.02 && this._w.walk > 0.02) for (const h of ["lower", "upper"]) this.a[`run_${h}`].time = ph * this.dur.run;
    this._phase = this._w.run > this._w.walk ? (this.a.run_lower.time / this.dur.run) % 1 : ph;

    // gestures take over the upper body
    if ((this.wave > 0 || this.cheer > 0) && !this._waving) {
      this.a.wave.reset().setEffectiveWeight(1).play();
      this._waving = true;
    }
    if (this.wave <= 0 && this.cheer <= 0) this._waving = false;
    this.wave = Math.max(0, this.wave - dt);
    this.cheer = Math.max(0, this.cheer - dt);
    this._interact = Math.max(0, this._interact - dt);
    const waveOn = this.a.wave.isRunning() ? 1 : 0;
    const talkOn = this.talk > 0 ? 1 : 0;
    const interactOn = this._interact > 0 ? 1 : 0;
    if (talkOn && !this.a.talk.isRunning()) this.a.talk.reset().play();
    this.a.talk.setEffectiveWeight(damp(this.a.talk.getEffectiveWeight(), talkOn && !waveOn && !interactOn ? 1 : 0, k));
    if (!talkOn && this.a.talk.getEffectiveWeight() < 0.01) this.a.talk.stop();
    this.a.wave.setEffectiveWeight(waveOn);
    this.a.interact.setEffectiveWeight(interactOn);
    this.a.hold.setEffectiveWeight(damp(this.a.hold.getEffectiveWeight(), this.holding && !waveOn && !interactOn && !talkOn ? 0.75 : 0, k));
    this._gesture = damp(this._gesture, Math.min(1, waveOn + talkOn + interactOn + (this.holding ? 0.75 : 0)), Math.min(1, dt * 12));

    for (const n of LOCO) {
      this.a[`${n}_lower`].setEffectiveWeight(this._w[n] * (n === "fall" ? 1 - jumpW : ground));
      this.a[`${n}_upper`].setEffectiveWeight(this._w[n] * (n === "fall" ? 1 - jumpW : ground) * (1 - this._gesture));
    }

    // footsteps: one per half cycle while moving on the ground
    if (s > 0.6 && !this.air) {
      const half = Math.floor(this._phase * 2);
      if (half !== this._lastStep) {
        this._lastStep = half;
        this.stepCb?.(half);
      }
    }

    this.mixer.update(dt);

    // squash on landings (same contract as the old Character)
    this.squash = Math.max(0, this.squash - dt * 4);
    const sq = Math.sin(this.squash * Math.PI) * 0.12;
    const b = this.baseScale;
    this.rig.scale.set(HUMAN_SCALE * b.x * (1 + sq * 0.5), HUMAN_SCALE * b.y * (1 - sq), HUMAN_SCALE * b.z * (1 + sq * 0.5));
  }
}

// ---------------------------------------------------------------- look
const HAIR_BY_LOOK = ["short", "long", "bun"];
const HAIR_BY_FACE = [null, "buzz", "curly", "quiff", "bun", "curly", "long"];
const part = (geo, color, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) => {
  const m = new THREE.Mesh(geo, toon(color));
  m.position.set(...pos);
  m.rotation.set(...rot);
  m.scale.set(...scale);
  m.castShadow = true;
  return m;
};

/** Head dimensions in the head bone's space (from the actual meshes), for hats and glasses. */
function anchors(h) {
  if (h._anchors) return h._anchors;
  const box = (m) => {
    m.geometry.computeBoundingBox();
    return m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
  };
  const head = box(h.meshes.m_head);
  const eyeL = box(h.meshes.m_eye_L);
  const eyeR = box(h.meshes.m_eye_R);
  const eyes = eyeL.clone().union(eyeR);
  const c = head.getCenter(new THREE.Vector3());
  h._anchors = {
    crown: head.max.y,
    centerY: c.y,
    centerZ: c.z,
    halfW: (head.max.x - head.min.x) / 2,
    halfD: (head.max.z - head.min.z) / 2,
    front: head.max.z,
    eyeY: (eyes.min.y + eyes.max.y) / 2,
    eyeX: (eyeL.getCenter(new THREE.Vector3()).x - eyeR.getCenter(new THREE.Vector3()).x) / 2,
    eyeZ: eyes.max.z,
    eyeR: (eyeL.max.y - eyeL.min.y) / 2,
  };
  return h._anchors;
}

function hat(kind, color, A) {
  const g = new THREE.Group();
  const r = Math.max(A.halfW, A.halfD) * 1.02;
  const top = A.crown;
  if (kind === 0) {
    // a modern cap: dome + curved brim facing forward
    g.add(part(new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), color, [0, top - r * 0.62, A.centerZ - r * 0.04], [0, 0, 0], [1.02, 0.78, 1.02]));
    g.add(part(new THREE.CylinderGeometry(r * 0.95, r * 0.95, r * 0.05, 24, 1, false, -Math.PI * 0.42, Math.PI * 0.84), color, [0, top - r * 0.6, A.centerZ + r * 0.38], [0.18, 0, 0], [1, 1, 1.15]));
    g.add(part(new THREE.SphereGeometry(r * 0.08, 8, 6), P.butter, [0, top + r * 0.12, A.centerZ]));
  } else if (kind === 2) {
    g.add(part(new THREE.SphereGeometry(r * 1.03, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), color, [0, top - r * 0.7, A.centerZ], [0, 0, 0], [1, 0.95, 1]));
    g.add(part(new THREE.TorusGeometry(r * 1.0, r * 0.13, 8, 26), color, [0, top - r * 0.62, A.centerZ], [Math.PI / 2 - 0.12, 0, 0]));
    g.add(part(new THREE.SphereGeometry(r * 0.22, 10, 8), P.cream, [0, top + r * 0.18, A.centerZ]));
  } else if (kind === 3) {
    g.add(part(new THREE.CylinderGeometry(r * 2.0, r * 2.05, r * 0.08, 30), 0xe6c27a, [0, top - r * 0.35, A.centerZ]));
    g.add(part(new THREE.CylinderGeometry(r * 0.86, r * 1.0, r * 0.62, 24), 0xe6c27a, [0, top - r * 0.08, A.centerZ]));
    g.add(part(new THREE.CylinderGeometry(r * 1.01, r * 1.01, r * 0.16, 24), color, [0, top - r * 0.26, A.centerZ]));
  } else if (kind === 4) {
    g.add(part(new THREE.CylinderGeometry(r * 1.5, r * 1.5, r * 0.07, 28), color, [0, top - r * 0.3, A.centerZ]));
    g.add(part(new THREE.CylinderGeometry(r * 0.86, r * 0.9, r * 1.5, 24), color, [0, top + r * 0.45, A.centerZ]));
    g.add(part(new THREE.CylinderGeometry(r * 0.905, r * 0.905, r * 0.2, 24), P.butter, [0, top - r * 0.15, A.centerZ]));
  }
  return g;
}

function glasses(style, A) {
  const g = new THREE.Group();
  const z = A.eyeZ + 0.012;
  const y = A.eyeY;
  const rr = A.eyeR * 1.25;
  const ink = style === 4 ? 0x1b1a20 : P.ink;
  for (const s of [-1, 1]) {
    const x = s * A.eyeX;
    if (style === 1) g.add(part(new THREE.TorusGeometry(rr, rr * 0.13, 6, 22), ink, [x, y, z]));
    else {
      const w = rr * 2.2;
      const h = style === 3 ? rr * 1.5 : rr * 1.75;
      for (const [ox, oy, bw, bh] of [[0, h / 2, w, rr * 0.18], [0, -h / 2, w, rr * 0.15], [-w / 2, 0, rr * 0.15, h], [w / 2, 0, rr * 0.15, h]]) g.add(part(new THREE.BoxGeometry(bw, bh, rr * 0.15), ink, [x + ox, y + oy, z], [0, 0, style === 3 ? s * 0.2 : 0]));
      if (style === 4) {
        const lens = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.95, h * 0.95), new THREE.MeshBasicMaterial({ color: 0x1e2230, transparent: true, opacity: 0.86 }));
        lens.position.set(x, y, z - 0.002);
        g.add(lens);
      }
    }
    // arms back to the ears
    g.add(part(new THREE.BoxGeometry(rr * 0.12, rr * 0.12, A.halfD * 1.05), ink, [s * (A.halfW * 0.98), y + rr * 0.3, A.centerZ + A.halfD * 0.35]));
  }
  g.add(part(new THREE.BoxGeometry(A.eyeX * 0.75, rr * 0.13, rr * 0.13), ink, [0, y + rr * 0.35, z]));
  return g;
}

function accessory(kind, A) {
  const g = new THREE.Group();
  if (kind === 2) {
    g.add(part(new THREE.TorusGeometry(A.halfW * 1.08, A.halfW * 0.08, 8, 28, Math.PI), P.ink, [0, A.centerY + 0.01, A.centerZ]));
    for (const s of [-1, 1]) g.add(part(new THREE.CylinderGeometry(A.halfW * 0.3, A.halfW * 0.3, A.halfW * 0.22, 18), 0xb85c4a, [s * A.halfW * 1.05, A.centerY + 0.005, A.centerZ], [0, 0, Math.PI / 2]));
  } else if (kind === 3) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.add(part(new THREE.SphereGeometry(A.halfW * 0.16, 8, 6), P.petal, [A.halfW * 0.92 + Math.cos(a) * A.halfW * 0.16, A.crown - A.halfW * 0.55 + Math.sin(a) * A.halfW * 0.16, A.centerZ + A.halfD * 0.3]));
    }
    g.add(part(new THREE.SphereGeometry(A.halfW * 0.12, 8, 6), P.butter, [A.halfW * 0.95, A.crown - A.halfW * 0.55, A.centerZ + A.halfD * 0.34]));
  }
  return g;
}

/** Apply a look (shared/look.js, plus the optional face from shared/face.js) to a Human. */
export function applyHumanLook(h, raw) {
  const look = cleanLook(raw);
  const face = cleanFace(raw?.face);
  if (face) look.face = face;
  h.look = look;
  const col = {
    h_skin: O.skin[look.skin].hex,
    h_lid: O.skin[look.skin].hex,
    h_hair: O.hair[look.hair].hex,
    h_brow: O.hair[look.hair].hex,
    h_jacket: O.jacket[look.jacket].hex,
    h_pants: O.pants[look.pants].hex,
    h_tee: O.scarf[look.scarf].hex,
    ...(face ? { h_iris: F.eyeColor[face.eyeColor].hex } : {}),
  };
  h.rig.traverse((m) => {
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (col[mat.name] !== undefined) mat.color.setHex(col[mat.name]);
  });
  // hairstyle: the face's style wins when set; a hat keeps the hair tucked (short/buzz) to avoid poking through
  let style = (face && HAIR_BY_FACE[face.hairStyle]) || HAIR_BY_LOOK[look.hairStyle] || "short";
  if (look.hat !== 1 && (style === "curly" || style === "quiff" || style === "bun")) style = "short";
  for (const n of ["short", "quiff", "curly", "buzz", "long", "bun"]) {
    const m = h.meshes[`m_hair_${n}`];
    if (m) m.visible = n === style;
  }
  const A = anchors(h);
  h.extras?.forEach((e) => e.removeFromParent());
  const glassStyle = face?.glasses || (look.accessory === 1 ? 1 : 0);
  h.extras = [look.hat !== 1 ? hat(look.hat, O.hatColor[look.hatColor].hex, A) : new THREE.Group(), glassStyle ? glasses(glassStyle, A) : new THREE.Group(), accessory(look.accessory, A)];
  h.extras.forEach((e) => h.p.head.add(e));
  const b = O.body[look.body];
  h._bs = new THREE.Vector3(b.sx, b.sy, b.sx);
  return look;
}
