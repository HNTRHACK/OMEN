// Avatar customization on the original Blender courier (KAI): recolours its named materials and
// attaches small toon-shaded parts (hats, hair, accessories) to its head bone, plus pets that
// follow their owner. Everything uses the game's toon material, so the ink-outline pass draws it
// like the rest of Blockhaven.
import * as THREE from "three";
import { toon } from "./assets.js";
import { R, P } from "./palette.js";
import { LOOK_OPTIONS, cleanLook } from "../shared/look.js";
import { applyFace } from "./avatar-face.js";

const O = LOOK_OPTIONS;
const mesh = (geo, color, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) => {
  const m = new THREE.Mesh(geo, toon(color));
  m.position.set(...pos);
  m.rotation.set(...rot);
  m.scale.set(...scale);
  m.castShadow = true;
  return m;
};

// Head-bone local space: origin at the neck, +Y up, +Z forward. Crown ≈ y 0.48, face ≈ z 0.23.
function hatMesh(kind, color) {
  const g = new THREE.Group();
  if (kind === 2) {
    // beanie
    g.add(mesh(new THREE.SphereGeometry(0.275, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), color, [0, 0.38, 0.005], [0, 0, 0], [1, 1.05, 1]));
    g.add(mesh(new THREE.TorusGeometry(0.265, 0.045, 8, 24), color, [0, 0.39, 0.005], [Math.PI / 2, 0, 0]));
    g.add(mesh(new THREE.SphereGeometry(0.07, 10, 8), P.cream, [0, 0.69, 0]));
  } else if (kind === 3) {
    // straw hat
    g.add(mesh(new THREE.CylinderGeometry(0.48, 0.5, 0.035, 26), 0xe6c27a, [0, 0.47, 0]));
    g.add(mesh(new THREE.CylinderGeometry(0.21, 0.25, 0.17, 20), 0xe6c27a, [0, 0.56, 0]));
    g.add(mesh(new THREE.CylinderGeometry(0.252, 0.252, 0.05, 20), color, [0, 0.505, 0]));
  } else if (kind === 4) {
    // top hat
    g.add(mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.03, 24), color, [0, 0.48, 0]));
    g.add(mesh(new THREE.CylinderGeometry(0.2, 0.21, 0.42, 20), color, [0, 0.7, 0]));
    g.add(mesh(new THREE.CylinderGeometry(0.212, 0.212, 0.06, 20), P.butter, [0, 0.53, 0]));
  }
  return g;
}

function hairMesh(style, color) {
  const g = new THREE.Group();
  if (style === 1) g.add(mesh(new THREE.BoxGeometry(0.5, 0.42, 0.12), color, [0, 0.12, -0.22], [0.08, 0, 0])); // long, down the back
  if (style === 2) g.add(mesh(new THREE.SphereGeometry(0.13, 12, 10), color, [0, 0.42, -0.24])); // bun
  return g;
}

function accessoryMesh(kind) {
  const g = new THREE.Group();
  if (kind === 1) {
    // round glasses
    for (const x of [-0.11, 0.11]) g.add(mesh(new THREE.TorusGeometry(0.068, 0.014, 6, 18), P.ink, [x, 0.245, 0.245]));
    g.add(mesh(new THREE.BoxGeometry(0.08, 0.016, 0.016), P.ink, [0, 0.255, 0.25]));
  } else if (kind === 2) {
    // headphones
    g.add(mesh(new THREE.TorusGeometry(0.29, 0.028, 8, 26, Math.PI), P.ink, [0, 0.26, 0]));
    for (const x of [-0.285, 0.285]) g.add(mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 16), 0xb85c4a, [x, 0.25, 0], [0, 0, Math.PI / 2]));
  } else if (kind === 3) {
    // a flower tucked by the ear
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.add(mesh(new THREE.SphereGeometry(0.045, 8, 6), P.petal, [0.24 + Math.cos(a) * 0.05, 0.36 + Math.sin(a) * 0.05, 0.08]));
    }
    g.add(mesh(new THREE.SphereGeometry(0.035, 8, 6), P.butter, [0.255, 0.36, 0.1]));
  }
  return g;
}

/** Apply a look to a Character built with { unique: true }. */
export function applyLook(c, raw) {
  const look = cleanLook(raw);
  c.look = look;
  const head = c.p.head;
  c.rig.traverse((m) => {
    if (!m.isMesh || !m.material?.name) return;
    const n = m.material.name;
    const onHead = m.parent === head;
    if (n === "skin") m.material.color.setHex(O.skin[look.skin].hex);
    else if (n === "hair") m.material.color.setHex(O.hair[look.hair].hex);
    else if (n === "teal") m.material.color.setHex(O.jacket[look.jacket].hex);
    else if (n === "navy") m.material.color.setHex(O.pants[look.pants].hex);
    else if (n === "butter" && !onHead) m.material.color.setHex(O.scarf[look.scarf].hex); // scarf (+ the letter in the satchel)
    if (onHead && (n === "red" || n === "butter")) {
      // the courier cap and its badge
      m.visible = look.hat === 0;
      if (n === "red") m.material.color.setHex(O.hatColor[look.hatColor].hex);
    }
  });
  c.extras?.forEach((e) => e.removeFromParent());
  c.extras = [hatMesh(look.hat, O.hatColor[look.hatColor].hex), hairMesh(look.hairStyle, O.hair[look.hair].hex), accessoryMesh(look.accessory)];
  c.extras.forEach((e) => head.add(e));
  const b = O.body[look.body];
  c._bs = new THREE.Vector3(b.sx, b.sy, b.sx); // Character.update squashes relative to this
  c.rig.scale.copy(c._bs);
  // The optional face (shared/face.js): kept on the look object so it saves and syncs with it.
  const face = applyFace(c, raw?.face, look);
  if (face) look.face = face;
  return look;
}

// ------------------------------------------------------------------ pets

function petMesh(kind) {
  const g = new THREE.Group();
  if (kind === 1) {
    // cat
    g.add(mesh(new THREE.BoxGeometry(0.2, 0.17, 0.36), 0xe08a3c, [0, 0.17, 0]));
    g.add(mesh(new THREE.SphereGeometry(0.12, 12, 10), 0xe08a3c, [0, 0.3, 0.2]));
    for (const x of [-0.07, 0.07]) g.add(mesh(new THREE.ConeGeometry(0.045, 0.09, 4), 0xe08a3c, [x, 0.42, 0.2]));
    g.add(mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.3, 6), 0xe08a3c, [0, 0.33, -0.22], [-0.6, 0, 0]));
    for (const x of [-0.045, 0.045]) g.add(mesh(new THREE.SphereGeometry(0.018, 6, 6), P.ink, [x, 0.32, 0.31]));
  } else if (kind === 2) {
    // dog
    g.add(mesh(new THREE.BoxGeometry(0.24, 0.2, 0.42), 0x9a6a44, [0, 0.2, 0]));
    g.add(mesh(new THREE.BoxGeometry(0.2, 0.18, 0.2), 0x9a6a44, [0, 0.34, 0.26]));
    g.add(mesh(new THREE.BoxGeometry(0.1, 0.07, 0.09), 0x7a5034, [0, 0.31, 0.39]));
    for (const x of [-0.11, 0.11]) g.add(mesh(new THREE.BoxGeometry(0.05, 0.14, 0.1), 0x6b432c, [x, 0.31, 0.24]));
    g.add(mesh(new THREE.CylinderGeometry(0.025, 0.018, 0.18, 6), 0x9a6a44, [0, 0.33, -0.24], [-0.9, 0, 0]));
    for (const x of [-0.05, 0.05]) g.add(mesh(new THREE.SphereGeometry(0.02, 6, 6), P.ink, [x, 0.38, 0.36]));
  } else if (kind === 3) {
    // bird
    g.add(mesh(new THREE.SphereGeometry(0.11, 12, 10), 0x6fb7d4, [0, 0, 0]));
    g.add(mesh(new THREE.ConeGeometry(0.035, 0.08, 6), P.butter, [0, 0, 0.13], [Math.PI / 2, 0, 0]));
    const wings = [-1, 1].map((s) => mesh(new THREE.BoxGeometry(0.16, 0.02, 0.1), 0x4a90b0, [s * 0.11, 0.02, 0]));
    wings.forEach((w) => g.add(w));
    g.userData.wings = wings;
    for (const x of [-0.04, 0.04]) g.add(mesh(new THREE.SphereGeometry(0.016, 6, 6), P.ink, [x, 0.04, 0.09]));
  }
  return g;
}

const tmp = new THREE.Vector3();
/** A pet that trots (or flies) after its owner on the planet's surface. */
export class Pet {
  static flatWorld = false;
  constructor(scene, kind) {
    this.scene = scene;
    this.kind = kind;
    this.group = petMesh(kind);
    this.pos = null;
    this.t = Math.random() * 10;
    scene.add(this.group);
  }
  update(dt, owner, ownerSpeed) {
    const o = owner.position;
    const flat = Pet.flatWorld; // the expo hall has a flat floor at y = 0; Blockhaven is a sphere
    const up = flat ? new THREE.Vector3(0, 1, 0) : o.clone().normalize();
    const back = new THREE.Vector3(0, 0, -1).applyQuaternion(owner.quaternion);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(owner.quaternion);
    const flying = this.kind === 3;
    const target = o.clone().addScaledVector(back, flying ? 0.5 : 0.95).addScaledVector(side, flying ? 0.45 : 0.55);
    if (!this.pos || this.pos.distanceTo(target) > 12) this.pos = target.clone(); // spawn / teleport
    const before = this.pos.clone();
    this.pos.lerp(target, Math.min(1, dt * (2.4 + ownerSpeed * 0.4)));
    this.t += dt * (4 + ownerSpeed * 2);
    const n = this.pos.clone().normalize();
    const h = flying ? 1.55 + Math.sin(this.t * 0.8) * 0.12 : Math.abs(Math.sin(this.t)) * Math.min(0.08, ownerSpeed * 0.02);
    if (flat) this.pos.y = 0;
    else this.pos.copy(n.multiplyScalar(R));
    this.group.position.copy(this.pos).addScaledVector(up, h);
    const vel = tmp.copy(this.pos).sub(before);
    vel.sub(up.clone().multiplyScalar(vel.dot(up)));
    const fwd = vel.lengthSq() > 1e-6 ? vel.normalize() : back.clone().negate();
    this.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, fwd).normalize(), up, fwd));
    if (this.group.userData.wings) this.group.userData.wings.forEach((w, i) => (w.rotation.z = (i ? -1 : 1) * Math.sin(this.t * 6) * 0.6));
  }
  dispose() {
    this.scene.remove(this.group);
  }
}

/** Keep a character's pet in sync with its look (creates, swaps or removes it). */
export function syncPet(scene, holder, kind) {
  if (holder.pet?.kind === kind) return holder.pet;
  holder.pet?.dispose();
  holder.pet = kind ? new Pet(scene, kind) : null;
  return holder.pet;
}
