import * as THREE from "three";
import { P, R } from "./palette.js";
import { toon } from "./assets.js";

// ------------------------------------------------------------------ the delivery envelope

export const flying = new Set(); // every envelope in the air; updated by the main loop

export class Envelope {
  constructor(scene) {
    this.scene = scene;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.03, 0.3), toon(P.cream));
    const flap = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.15, 3), toon(P.butter));
    flap.rotation.set(Math.PI / 2, 0, 0);
    flap.scale.set(1, 1, 0.12);
    flap.position.set(0, 0.022, -0.04);
    const seal = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 10), toon(P.brick));
    seal.position.set(0, 0.03, 0.01);
    g.add(body, flap, seal);
    g.scale.setScalar(1.6);
    this.mesh = g;
    this.anim = null;
    this.trail = [];
  }

  /** Arc from a to b; resolves on arrival. */
  fly(a, b, { height = 2.2, duration = 1.6 } = {}) {
    this.mesh.position.copy(a);
    this.scene.add(this.mesh);
    flying.add(this);
    return new Promise((resolve) => (this.anim = { a: a.clone(), b: b.clone(), t: 0, height, duration, resolve }));
  }

  update(dt) {
    if (!this.anim) return;
    const a = this.anim;
    a.t = Math.min(1, a.t + dt / a.duration);
    const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;
    const up = a.a.clone().add(a.b).normalize();
    const p = a.a.clone().lerp(a.b, e).addScaledVector(up, Math.sin(Math.PI * e) * a.height);
    const prev = this.mesh.position.clone();
    this.mesh.position.copy(p);
    const v = p.clone().sub(prev);
    if (v.lengthSq() > 1e-8) {
      this.mesh.up.copy(up);
      this.mesh.lookAt(p.clone().add(v));
      this.mesh.rotateZ(Math.sin(a.t * 20) * 0.3);
    }
    if (a.t >= 1) {
      this.anim = null;
      this.scene.remove(this.mesh);
      flying.delete(this);
      a.resolve();
    }
  }
}

// ------------------------------------------------------------------ particles (petals, sparks)

export class Particles {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.petal = new THREE.PlaneGeometry(0.16, 0.11);
    this.spark = new THREE.OctahedronGeometry(0.07, 0);
    this.mats = {
      petal: [P.petal, P.butter, P.cream, 0xf5a9b8].map((c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })),
      spark: [P.netGlow, 0xffffff, P.glow].map((c) => new THREE.MeshBasicMaterial({ color: c })),
    };
  }

  burst(at, kind = "petal", n = 60, power = 6) {
    const up = at.clone().normalize();
    const mats = this.mats[kind];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(kind === "petal" ? this.petal : this.spark, mats[i % mats.length]);
      m.position.copy(at);
      const r = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(power * 1.4);
      const v = up.clone().multiplyScalar(power * (0.7 + Math.random() * 0.6)).add(r);
      this.scene.add(m);
      this.list.push({ m, v, life: kind === "petal" ? 2.8 + Math.random() * 1.5 : 0.9 + Math.random() * 0.5, kind, spin: Math.random() * 8 });
    }
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      const g = p.m.position.clone().normalize().multiplyScalar(p.kind === "petal" ? -4 : -9);
      p.v.addScaledVector(g, dt).multiplyScalar(1 - dt * (p.kind === "petal" ? 2.2 : 1.2));
      if (p.kind === "petal") p.v.add(new THREE.Vector3(Math.sin(p.life * 3 + i), 0, Math.cos(p.life * 2.6 + i)).multiplyScalar(dt * 1.5));
      p.m.position.addScaledVector(p.v, dt);
      p.m.rotation.x += p.spin * dt;
      p.m.rotation.y += p.spin * 0.7 * dt;
      p.life -= dt;
      if (p.kind === "spark") p.m.scale.setScalar(Math.max(0.01, p.life));
      if (p.life <= 0 || p.m.position.length() < R) {
        this.scene.remove(p.m);
        this.list.splice(i, 1);
      }
    }
  }
}

// ------------------------------------------------------------------ chimney smoke

export class Smoke {
  constructor(scene, sources) {
    this.scene = scene;
    this.sources = sources; // world positions
    this.geo = new THREE.IcosahedronGeometry(0.28, 1);
    this.mat = new THREE.MeshToonMaterial({ color: 0xfaf3ea, transparent: true, opacity: 0.85 });
    this.puffs = [];
    this.t = 0;
  }

  update(dt) {
    this.t += dt;
    if (this.t > 0.55) {
      this.t = 0;
      for (const s of this.sources) {
        const m = new THREE.Mesh(this.geo, this.mat.clone());
        m.position.copy(s);
        this.scene.add(m);
        this.puffs.push({ m, life: 0, up: s.clone().normalize(), drift: new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.3) });
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.life += dt;
      p.m.position.addScaledVector(p.up, dt * 0.9).addScaledVector(p.drift, dt);
      p.m.scale.setScalar(0.6 + p.life * 0.9);
      p.m.material.opacity = Math.max(0, 0.85 - p.life * 0.32);
      if (p.life > 2.7) {
        this.scene.remove(p.m);
        p.m.material.dispose();
        this.puffs.splice(i, 1);
      }
    }
  }
}

// ------------------------------------------------------------------ birds

export class Birds {
  constructor(scene, n = 9) {
    this.group = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.35, 0, -0.05, 0, 0, 0.12, 0, 0.02, -0.05, 0, 0, 0.12, 0.35, 0, -0.05, 0, 0.02, -0.05], 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: P.ink, side: THREE.DoubleSide });
    this.birds = [];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, mat);
      this.group.add(m);
      this.birds.push({ m, a: Math.random() * 6.28, r: 6 + Math.random() * 10, h: R + 12 + Math.random() * 6, s: 0.25 + Math.random() * 0.2, tilt: Math.random() * 0.6 });
    }
    scene.add(this.group);
  }

  update(dt, t) {
    for (const b of this.birds) {
      b.a += dt * b.s;
      const p = new THREE.Vector3(Math.cos(b.a) * b.r, 0, Math.sin(b.a) * b.r).applyAxisAngle(new THREE.Vector3(1, 0, 0), b.tilt);
      p.y += b.h;
      const next = new THREE.Vector3(Math.cos(b.a + 0.1) * b.r, 0, Math.sin(b.a + 0.1) * b.r).applyAxisAngle(new THREE.Vector3(1, 0, 0), b.tilt);
      next.y += b.h;
      b.m.position.copy(p);
      b.m.lookAt(next);
      b.m.scale.y = 1 + Math.sin(t * 9 + b.a * 3) * 0.8; // flapping
      b.m.rotation.z = Math.sin(t * 9 + b.a * 3) * 0.4;
    }
  }
}
