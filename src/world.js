import * as THREE from "three";
import { R } from "./palette.js";
import { model, instanced, grad } from "./assets.js";
import { makePlanet, makeSky, mapDir, mapMatrix, placeMap, smoothPath, surfaceMatrix, tangentToward } from "./planet.js";
import { SPOTS, LANES, AREAS, PROPS, SOLIDS } from "./layout.js";

// Seeded randomness so Blockhaven is the same village every visit.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distToPolyline(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

export function buildWorld(scene) {
  const rand = rng(1337);
  const lanes = LANES.map((l) => smoothPath(l, 1.4));
  const laneDist = (x, z) => Math.min(...lanes.map((l) => distToPolyline(x, z, l)));
  const segments = [];
  for (const l of lanes) for (let i = 0; i < l.length - 1; i++) segments.push([l[i], l[i + 1]]);

  const planet = makePlanet(segments, AREAS, grad);
  const sky = makeSky();
  scene.add(planet, sky);

  // colliders (direction + radius in metres) and things the camera shouldn't pass through
  const colliders = [];
  const solid = (x, z, r) => colliders.push({ dir: mapDir(x, z), r });
  SOLIDS.forEach(([x, z, r]) => solid(x, z, r));
  const camBlockers = [];

  // ---------------------------------------------------------------- hero buildings
  const hero = {};
  const putHero = (key, name, spot) => {
    const o = model(name);
    placeMap(o, spot.at[0], spot.at[1], spot.face[0], spot.face[1]);
    scene.add(o);
    camBlockers.push(o);
    hero[key] = o;
    return o;
  };
  putHero("post", "post_office", SPOTS.post);
  putHero("chai", "chai_shop", SPOTS.chai);
  putHero("workshop", "workshop", SPOTS.workshop);

  const relay = model("relay_lantern", { uniqueMaterials: true });
  placeMap(relay, 0, 0, 0, 6);
  scene.add(relay);
  const crystal = relay.getObjectByName("dyn_crystal");

  // ---------------------------------------------------------------- hand-placed props
  const groups = new Map();
  const add = (name, m) => {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(m);
  };
  for (const [name, x, z, fx, fz, s = 1] of PROPS) {
    const fwd = fx === 0 && fz === 0 ? null : [fx, fz];
    // props with face (0,0) look at the plaza centre from where they stand, i.e. face away from it
    const target = fwd || [x * 2, z * 2];
    const placement = mapMatrix(x, z, target[0], target[1], s);
    if (name === "signpost") {
      placement.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    }
    add(name, placement);
  }

  // ---------------------------------------------------------------- houses along the lanes
  const houses = [];
  const houseTypes = ["house_a", "house_b", "house_c", "house_d"];
  const nearSolid = (x, z, pad) => SOLIDS.some(([sx, sz, r]) => Math.hypot(x - sx, z - sz) < r + pad);
  const inArea = (x, z, pad) => AREAS.some(([ax, az, r]) => Math.hypot(x - ax, z - az) < r + pad);
  for (const l of lanes) {
    for (let i = 2; i < l.length - 2; i += 5) {
      const [x0, z0] = l[i];
      const [x1, z1] = l[i + 1];
      const tx = x1 - x0;
      const tz = z1 - z0;
      const len = Math.hypot(tx, tz);
      const nx = -tz / len;
      const nz = tx / len;
      for (const side of [-1, 1]) {
        const off = 5.6 + rand() * 0.8;
        const x = x0 + nx * off * side;
        const z = z0 + nz * off * side;
        if (Math.hypot(x, z) > 24.5) continue;
        if (laneDist(x, z) < 4.3) continue;
        if (nearSolid(x, z, 3.0) || inArea(x, z, 2.2)) continue;
        if (houses.some((h) => Math.hypot(h.x - x, h.z - z) < 6.3)) continue;
        const type = houseTypes[Math.floor(rand() * houseTypes.length)];
        houses.push({ x, z, type, fx: x0, fz: z0 });
      }
    }
  }
  for (const h of houses) {
    add(h.type, mapMatrix(h.x, h.z, h.fx, h.fz));
    solid(h.x, h.z, 2.5);
    // little touches: a planter by the door, sometimes a fence along one side
    const dir = mapDir(h.x, h.z);
    const fwd = tangentToward(dir, mapDir(h.fx, h.fz));
    const right = new THREE.Vector3().crossVectors(dir, fwd);
    if (rand() < 0.55) {
      const p = dir.clone().multiplyScalar(R).addScaledVector(fwd, 2.3).addScaledVector(right, 1.3);
      add("planter", surfaceMatrix(p.normalize(), fwd, 0.8));
    }
    if (rand() < 0.45) {
      for (const k of [0, 1]) {
        const p = dir.clone().multiplyScalar(R).addScaledVector(right, (rand() < 0.5 ? -1 : 1) * 2.6).addScaledVector(fwd, 1.2 - k * 2.0);
        add("fence", surfaceMatrix(p.normalize(), right, 1));
      }
    }
  }

  // ---------------------------------------------------------------- lanterns along the lanes
  const lampSpots = [];
  for (const l of lanes) {
    for (let i = 3; i < l.length - 1; i += 6) {
      const [x0, z0] = l[i];
      const [x1, z1] = l[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const side = i % 12 === 3 ? 1 : -1;
      const x = x0 + ((-(z1 - z0)) / len) * 2.2 * side;
      const z = z0 + ((x1 - x0) / len) * 2.2 * side;
      if (Math.hypot(x, z) < 6.5 || nearSolid(x, z, 0.6)) continue;
      if (lampSpots.some(([a, b]) => Math.hypot(a - x, b - z) < 5)) continue;
      lampSpots.push([x, z, x0, z0]);
    }
  }
  for (let k = 0; k < 4; k++) {
    const a = k * (Math.PI / 2) + 0.5;
    lampSpots.push([Math.cos(a) * 6.6, Math.sin(a) * 6.6, 0, 0]);
  }
  const lampMats = [];
  const lamps = [];
  for (const [x, z, fx, fz] of lampSpots) {
    const o = model("lantern_post", { uniqueMaterials: false });
    placeMap(o, x, z, fx === 0 && fz === 0 ? x * 2 : fx, fx === 0 && fz === 0 ? z * 2 : fz);
    scene.add(o);
    const lamp = o.getObjectByName("dyn_lamp");
    if (lamp && !lampMats.includes(lamp.material)) lampMats.push(lamp.material);
    lamps.push(o);
    solid(x, z, 0.3);
  }

  // ---------------------------------------------------------------- foliage
  const trees = { tree_round: [], tree_cypress: [], tree_pine: [], bush: [], rocks: [] };
  const free = (x, z, pad) =>
    laneDist(x, z) > 2.6 + pad &&
    !nearSolid(x, z, pad + 0.6) &&
    !inArea(x, z, pad + 0.5) &&
    !houses.some((h) => Math.hypot(h.x - x, h.z - z) < 3.4 + pad) &&
    !lampSpots.some(([a, b]) => Math.hypot(a - x, b - z) < 1.2);
  // inside the village: gardens and gaps
  for (let i = 0; i < 260 && trees.tree_round.length + trees.tree_cypress.length < 46; i++) {
    const a = rand() * Math.PI * 2;
    const r = 7 + rand() * 18;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!free(x, z, 0.4)) continue;
    const kind = rand() < 0.65 ? "tree_round" : "tree_cypress";
    trees[kind].push(mapMatrix(x, z, x + rand(), z + rand(), 0.85 + rand() * 0.4));
    solid(x, z, 0.45);
  }
  for (let i = 0; i < 200 && trees.bush.length < 40; i++) {
    const a = rand() * Math.PI * 2;
    const r = 5 + rand() * 20;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!free(x, z, 0)) continue;
    trees.bush.push(mapMatrix(x, z, x + rand() - 0.5, z + rand() - 0.5, 0.7 + rand() * 0.5));
  }
  // beyond the village: a forest over the rest of the little planet
  const tmp = new THREE.Vector3();
  for (let i = 0; i < 1400 && trees.tree_pine.length < 330; i++) {
    tmp.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    const polar = Math.acos(tmp.y) * R;
    if (polar < 27) continue;
    const dir = tmp.clone();
    const fwd = tangentToward(dir, new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize());
    const roll = rand();
    const kind = roll < 0.55 ? "tree_pine" : roll < 0.85 ? "tree_round" : roll < 0.93 ? "bush" : "rocks";
    trees[kind].push(surfaceMatrix(dir, fwd, 0.9 + rand() * 0.7));
  }
  for (const [k, list] of Object.entries(trees)) for (const m of list) add(k, m);

  // ---------------------------------------------------------------- build instanced groups
  for (const [name, list] of groups) {
    const g = instanced(name, list, { shadows: !["bush", "rocks"].includes(name) });
    scene.add(g);
    if (name.startsWith("house")) camBlockers.push(g);
  }

  return {
    planet,
    sky,
    hero,
    relay,
    crystal,
    lamps,
    lampMats,
    colliders,
    camBlockers,
    lanes,
    houses,
  };
}
