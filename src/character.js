import * as THREE from "three";
import { model } from "./assets.js";

/** Courier outfits (jacket, cap) from the game's palette. 0 is KAI's original look. */
export const OUTFITS = [
  { name: "Courier teal", jacket: 0x3e8e8a, cap: 0xc8473d },
  { name: "Brick", jacket: 0xb85c4a, cap: 0xf3d98b },
  { name: "Slate", jacket: 0x5f7d99, cap: 0xc8473d },
  { name: "Leaf", jacket: 0x5e9a5b, cap: 0xf3d98b },
  { name: "Plum", jacket: 0x7d5a8c, cap: 0x7fc4bc },
  { name: "Mustard", jacket: 0xc99a3c, cap: 0x2f3e5c },
];

const damp = (cur, target, k) => cur + (target - cur) * k;

/**
 * A Blender character (legL, legR, body → head, armL, armR) brought to life with procedural
 * animation: walk / run cycles, idle breathing, talking gestures, waves, cheers, jump poses.
 */
export class Character {
  constructor(name, { unique = false } = {}) {
    this.name = name;
    this.group = new THREE.Group(); // positioned on the planet by its controller
    this.rig = model(name, { uniqueMaterials: unique }); // unique: this character can be recoloured alone
    this.group.add(this.rig);
    const get = (n) => this.rig.getObjectByName(n);
    this.p = { legL: get("legL"), legR: get("legR"), body: get("body"), head: get("head"), armL: get("armL"), armR: get("armR") };
    this.rest = {};
    for (const [k, o] of Object.entries(this.p)) this.rest[k] = { pos: o.position.clone(), rot: o.rotation.clone() };
    this.phase = Math.random() * 10;
    this.speed = 0;
    this.air = false;
    this.talk = 0; // >0 while speaking (gesture intensity)
    this.wave = 0;
    this.cheer = 0;
    this.squash = 0;
    this.headYaw = 0;
    this.headTarget = 0;
    this.lean = 0;
    this.stepCb = null;
    this.lastStep = 0;
  }

  update(dt, t) {
    const { legL, legR, body, head, armL, armR } = this.p;
    const r = this.rest;
    const k = Math.min(1, dt * 10);
    const s = this.speed;
    const moving = s > 0.3 && !this.air;
    if (moving) this.phase += dt * (5.2 + s * 1.15);
    const sw = Math.sin(this.phase);
    const amp = Math.min(1.0, 0.25 + s * 0.12);

    let lL = 0;
    let lR = 0;
    let aL = 0;
    let aR = 0;
    let bob = 0;
    let lean = 0;
    let aLz = 0;
    let aRz = 0;
    if (this.air) {
      lL = -0.9;
      lR = 0.35;
      aL = -1.4;
      aR = -1.4;
      aLz = -0.5;
      aRz = 0.5;
    } else if (moving) {
      lL = sw * amp;
      lR = -sw * amp;
      aL = -sw * amp * 0.9;
      aR = sw * amp * 0.9;
      bob = Math.abs(Math.cos(this.phase)) * 0.06 * Math.min(1.6, s / 3);
      lean = Math.min(0.22, s * 0.03);
      // footsteps for audio
      const step = Math.floor(this.phase / Math.PI);
      if (step !== this.lastStep) {
        this.lastStep = step;
        this.stepCb?.(s);
      }
    } else {
      bob = Math.sin(t * 2.1 + this.phase) * 0.012; // breathing
      aL = Math.sin(t * 2.1 + this.phase) * 0.03;
      aR = -aL;
    }
    if (this.talk > 0) {
      // conversational gestures: one hand rises and turns, the head nods
      const g = Math.sin(t * 3.1) * 0.5 + 0.5;
      aR = damp(aR, -0.6 - g * 0.5, 1);
      aRz = 0.25 + g * 0.2;
    }
    if (this.wave > 0) {
      this.wave -= dt;
      aR = -2.8;
      aRz = 0.3 + Math.sin(t * 16) * 0.35;
    }
    if (this.cheer > 0) {
      this.cheer -= dt;
      const j = Math.abs(Math.sin(this.cheer * 9));
      bob = j * 0.35;
      aL = aR = -2.9;
      aLz = -0.35;
      aRz = 0.35;
    }
    if (this.holding) {
      aR = -1.1;
      aRz = 0.1;
    }

    legL.rotation.x = damp(legL.rotation.x, r.legL.rot.x + lL, k);
    legR.rotation.x = damp(legR.rotation.x, r.legR.rot.x + lR, k);
    armL.rotation.x = damp(armL.rotation.x, r.armL.rot.x + aL, k);
    armR.rotation.x = damp(armR.rotation.x, r.armR.rot.x + aR, k);
    armL.rotation.z = damp(armL.rotation.z, r.armL.rot.z + aLz, k);
    armR.rotation.z = damp(armR.rotation.z, r.armR.rot.z + aRz, k);
    this.lean = damp(this.lean, lean, k);
    body.rotation.x = r.body.rot.x + this.lean;
    body.position.y = r.body.pos.y + bob;

    // head: look toward a target yaw, plus nods while talking
    this.headYaw = damp(this.headYaw, this.headTarget, Math.min(1, dt * 4));
    head.rotation.y = r.head.rot.y + this.headYaw;
    head.rotation.x = r.head.rot.x + (this.talk > 0 ? Math.sin(t * 5.3) * 0.06 : 0);

    // landing squash & stretch on the whole rig
    this.squash = Math.max(0, this.squash - dt * 4);
    const sq = Math.sin(this.squash * Math.PI) * 0.16;
    this.rig.scale.set(this.baseScale.x * (1 + sq * 0.5), this.baseScale.y * (1 - sq), this.baseScale.z * (1 + sq * 0.5));
  }

  get baseScale() {
    if (!this._bs) this._bs = this.rig.scale.clone();
    return this._bs;
  }

  /** Recolour jacket + cap (needs `unique` materials, so no other character changes). */
  setOutfit(i) {
    const o = OUTFITS[((i % OUTFITS.length) + OUTFITS.length) % OUTFITS.length];
    this.outfit = OUTFITS.indexOf(o);
    this.rig.traverse((m) => {
      if (!m.isMesh) return;
      if (m.material.name === "teal") m.material.color.setHex(o.jacket);
      else if (m.material.name === "red") m.material.color.setHex(o.cap);
    });
  }

  /** World position of a point in the character's local space (e.g. hands, head). */
  local(x, y, z) {
    return this.group.localToWorld(new THREE.Vector3(x, y, z));
  }
}
