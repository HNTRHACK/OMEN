import * as THREE from "three";
import { R } from "./palette.js";

const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

function project(v, n) {
  return v.sub(n.clone().multiplyScalar(v.dot(n)));
}

/** KAI's movement on the sphere: camera-relative, eased, with jumping and sliding collisions. */
export class Mover {
  constructor(character, dir, fwd, colliders) {
    this.c = character;
    this.dir = dir.clone().normalize();
    this.fwd = project(fwd.clone(), this.dir).normalize();
    this.colliders = colliders;
    this.speed = 0;
    this.h = 0;
    this.vh = 0;
    this.grounded = true;
    this.enabled = false;
    this.onLand = null;
    this.onJump = null;
    this.apply();
  }

  get up() {
    return this.dir;
  }

  get position() {
    return this.c.group.position;
  }

  face(targetPos) {
    const t = project(targetPos.clone().normalize().sub(this.dir.clone().multiplyScalar(0)), this.dir);
    if (t.lengthSq() > 1e-8) this.fwd.copy(t.normalize());
    this.apply();
  }

  update(dt, input, camFwd) {
    const up = this.dir;
    const camF = project(camFwd.clone(), up).normalize();
    const camR = new THREE.Vector3().crossVectors(camF, up);
    let mx = this.enabled ? input.x : 0;
    let my = this.enabled ? input.y : 0;
    const mag = Math.min(1, Math.hypot(mx, my));
    const want = new THREE.Vector3().addScaledVector(camF, my).addScaledVector(camR, mx);
    const target = mag > 0.05 ? (input.run ? 6.4 : 3.6) * mag : 0;
    // ease in, ease out (a little quicker to stop than to start)
    this.speed += (target - this.speed) * Math.min(1, dt * (target > this.speed ? 5.5 : 8));
    if (mag > 0.05) {
      want.normalize();
      // turn toward the movement direction, faster at low speed
      const ang = this.fwd.angleTo(want);
      const sign = Math.sign(new THREE.Vector3().crossVectors(this.fwd, want).dot(up)) || 1;
      const turn = Math.min(ang, dt * (11 - Math.min(5, this.speed)));
      tmpQ.setFromAxisAngle(up, turn * sign);
      this.fwd.applyQuaternion(tmpQ);
    }
    if (this.speed > 0.01) {
      const axis = tmpV.crossVectors(up, this.fwd).normalize();
      tmpQ.setFromAxisAngle(axis, (this.speed * dt) / R);
      this.dir.applyQuaternion(tmpQ).normalize();
      this.fwd.applyQuaternion(tmpQ);
      this.collide();
    }
    project(this.fwd, this.dir).normalize();

    // jumping
    if (this.enabled && input.jump && this.grounded) {
      this.vh = 7.2;
      this.grounded = false;
      this.onJump?.();
    }
    input.jump = false;
    if (!this.grounded) {
      this.vh -= 21 * dt;
      this.h += this.vh * dt;
      if (this.h <= 0) {
        this.h = 0;
        this.vh = 0;
        this.grounded = true;
        this.c.squash = 1;
        this.onLand?.();
      }
    }
    this.c.speed = this.speed;
    this.c.air = !this.grounded;
    this.apply();
  }

  /** Push out of anything solid, so KAI slides around corners instead of sticking. */
  collide() {
    for (const col of this.colliders) {
      const ang = Math.acos(THREE.MathUtils.clamp(this.dir.dot(col.dir), -1, 1));
      const min = (col.r + 0.38) / R;
      if (ang < min) {
        const axis = new THREE.Vector3().crossVectors(col.dir, this.dir);
        if (axis.lengthSq() < 1e-12) continue;
        axis.normalize();
        this.dir.copy(col.dir).applyAxisAngle(axis, min);
        project(this.fwd, this.dir).normalize();
        this.speed *= 0.92;
      }
    }
  }

  apply() {
    const g = this.c.group;
    g.position.copy(this.dir).multiplyScalar(R + this.h);
    const right = new THREE.Vector3().crossVectors(this.dir, this.fwd);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, this.dir, this.fwd));
  }
}

/**
 * A close third-person camera: lazily swings behind KAI while walking, can be orbited by
 * dragging, pulls in when a building would block the view, and frames conversations.
 */
export class CameraRig {
  constructor(camera, blockers) {
    this.cam = camera;
    this.blockers = blockers;
    this.ray = new THREE.Raycaster();
    this.fwd = new THREE.Vector3(0, 0, 1);
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.dist = 7.8;
    this.height = 3.2;
    this.pitch = 0;
    this.manual = 0; // seconds since the player last orbited by hand
    this.blocked = this.dist;
    this.talk = null; // { a: Vector3, b: Vector3 } heads of the two speakers
    this.frame = 0;
  }

  orbit(dx, dy) {
    this.fwd.applyAxisAngle(this.up, -dx);
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy, -0.5, 0.75);
    this.manual = 0;
  }

  desired(m) {
    const up = m.dir;
    const f = project(this.fwd.clone(), up).normalize();
    const head = m.position.clone().addScaledVector(up, 1.45);
    const h = this.height + this.pitch * 3.2;
    const d = this.dist * (1 - this.pitch * 0.25);
    const pos = head.clone().addScaledVector(up, h - 1.45).addScaledVector(f, -d);
    const look = head.clone().addScaledVector(f, 3.2).addScaledVector(up, -0.35);
    return { pos, look, up, head };
  }

  snap(m) {
    this.fwd.copy(m.fwd);
    const d = this.desired(m);
    this.pos.copy(d.pos);
    this.look.copy(d.look);
    this.up.copy(d.up);
    this.apply();
  }

  update(m, dt) {
    const up = m.dir;
    project(this.fwd, up).normalize(); // carry the view direction along the curved ground
    this.manual += dt;
    // swing behind KAI while walking (not while the player is orbiting by hand)
    if (m.speed > 0.6 && this.manual > 1.2) {
      const k = Math.min(1, dt * 0.9 * Math.min(1.5, m.speed / 3.5));
      this.fwd.lerp(m.fwd, k).normalize();
    }
    let pos;
    let look;
    if (this.talk) {
      // over-the-shoulder from KAI's side: always outside, since KAI is always outside
      const { a, b } = this.talk; // a = KAI's head, b = the other speaker's head
      const toB = b.clone().sub(a);
      const flat = project(toB.clone(), up).normalize();
      const side = new THREE.Vector3().crossVectors(up, flat).normalize();
      pos = a.clone().addScaledVector(flat, -2.4).addScaledVector(side, 1.05).addScaledVector(up, 0.5);
      look = a.clone().lerp(b, 0.62).addScaledVector(up, -0.1);
    } else {
      const d = this.desired(m);
      // pull in if something solid sits between KAI and the camera (checked a few times a second)
      if (++this.frame % 4 === 0 && this.blockers.length) {
        const to = d.pos.clone().sub(d.head);
        const len = to.length();
        this.ray.set(d.head, to.normalize());
        this.ray.far = len;
        const hit = this.ray.intersectObjects(this.blockers, true)[0];
        this.blocked = hit ? Math.max(1.6, hit.distance - 0.45) : len;
        this.full = len;
      }
      const ratio = this.full ? Math.min(1, this.blocked / this.full) : 1;
      pos = d.head.clone().lerp(d.pos, ratio);
      look = d.look;
    }
    const k = 1 - Math.exp(-dt * (this.talk ? 3 : 7));
    this.pos.lerp(pos, k);
    this.look.lerp(look, Math.min(1, k * 1.4));
    this.up.lerp(up, k).normalize();
    this.apply();
  }

  apply() {
    this.cam.position.copy(this.pos);
    this.cam.up.copy(this.up);
    this.cam.lookAt(this.look);
  }
}
