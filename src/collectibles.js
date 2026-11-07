// Crypto discoveries: educational collectibles along Blockhaven's lanes. Walk up, press E, read
// live market data. They are NOT free crypto: nothing is ever credited to any wallet.
// Positions come from a generator seeded by the room code, so everyone in a room sees the same coins.
import * as THREE from "three";
import { R } from "./palette.js";
import { mapDir } from "./planet.js";
import { LANES } from "./layout.js";

export const COIN_DEFS = [
  { sym: "btc", name: "Bitcoin", glyph: "₿", face: "#f2a33a", rim: "#b8721c" },
  { sym: "eth", name: "Ethereum", glyph: "Ξ", face: "#8c9ce8", rim: "#5a68b0" },
  { sym: "sol", name: "Solana", glyph: "◎", face: "#9be3c8", rim: "#7a5ec4" },
  { sym: "usdt", name: "Tether", glyph: "₮", face: "#5cbf9a", rim: "#2f8a68" },
  { sym: "usdc", name: "USD Coin", glyph: "$", face: "#7aa7e0", rim: "#3d6aa8" },
  { sym: "wbt", name: "WhiteBIT Coin", glyph: "W", face: "#f1e6d2", rim: "#2b2230" },
];

/** Small deterministic PRNG (mulberry32) from a string seed. */
export function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same seed → same spots. Spots sit on lane interiors, spread apart, clear of colliders. */
export function coinSpots(seed, colliders, n = COIN_DEFS.length) {
  const rand = seeded(`omen-coins:${seed}`);
  const cands = [];
  for (const lane of LANES)
    for (let i = 0; i < lane.length - 1; i++)
      for (const t of [0.3, 0.7]) {
        const [ax, az] = lane[i];
        const [bx, bz] = lane[i + 1];
        cands.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      }
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  const out = [];
  for (const [x, z] of cands) {
    if (Math.hypot(x, z) < 4) continue; // keep the plaza for the relay
    if (out.some(([ox, oz]) => Math.hypot(x - ox, z - oz) < 7)) continue;
    const d = mapDir(x, z);
    if (colliders.some((c) => Math.acos(Math.min(1, d.dot(c.dir))) * R < c.r + 1.2)) continue;
    out.push([x, z]);
    if (out.length === n) break;
  }
  return out;
}

function faceTexture(def) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = def.rim;
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = def.face;
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#2b2230";
  g.lineWidth = 5;
  g.stroke();
  g.fillStyle = "#2b2230";
  g.font = "bold 70px 'Bricolage Grotesque', system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(def.glyph, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Collectibles {
  constructor(scene, colliders) {
    this.scene = scene;
    this.colliders = colliders;
    this.items = [];
    this.disc = new THREE.CylinderGeometry(0.42, 0.42, 0.09, 32);
    this.ring = new THREE.TorusGeometry(0.62, 0.025, 6, 40);
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0.55, depthWrite: false });
  }

  /** (Re)place the coins for a seed (the room code, or "solo"). */
  place(seed) {
    for (const it of this.items) this.scene.remove(it.group);
    this.items = [];
    this.seed = seed;
    coinSpots(seed, this.colliders).forEach(([x, z], i) => {
      const def = COIN_DEFS[i];
      const tex = faceTexture(def);
      const faceMat = new THREE.MeshBasicMaterial({ map: tex });
      const edgeMat = new THREE.MeshToonMaterial({ color: def.rim });
      const coin = new THREE.Mesh(this.disc, [edgeMat, faceMat, faceMat]);
      coin.rotation.x = Math.PI / 2;
      const spinner = new THREE.Group();
      spinner.add(coin);
      const ring = new THREE.Mesh(this.ring, this.glowMat);
      const group = new THREE.Group();
      group.add(spinner, ring);
      const dir = mapDir(x, z);
      group.position.copy(dir).multiplyScalar(R + 1.15);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      ring.rotation.x = Math.PI / 2;
      this.scene.add(group);
      this.items.push({ def, group, spinner, ring, dir, phase: i * 1.3, burst: 0 });
    });
    return this.items;
  }

  update(dt, t, found) {
    for (const it of this.items) {
      it.spinner.rotation.y += dt * (it.burst > 0 ? 9 : 1.1);
      it.spinner.position.y = Math.sin(t * 1.8 + it.phase) * 0.12;
      const pulse = 0.5 + Math.sin(t * 2.4 + it.phase) * 0.5;
      it.ring.scale.setScalar(found.has(it.def.sym) ? 0.85 : 1 + pulse * 0.12);
      it.ring.visible = !found.has(it.def.sym) || it.burst > 0;
      it.burst = Math.max(0, it.burst - dt);
    }
  }

  /** World position for interaction checks (on the ground below the coin). */
  groundAt(it) {
    return it.dir.clone().multiplyScalar(R);
  }
  headAt(it) {
    return it.dir.clone().multiplyScalar(R + 2.1);
  }
}
