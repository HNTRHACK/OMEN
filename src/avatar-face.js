// Facial customisation on the original Blender courier, without touching its rig or animations.
//
// The head is one bone (a Group) holding small meshes per material: "skin" (head + nose), "ink"
// (both eyes), "flower_pink" (blush), hair and cap. A face is applied by
//   - scaling the head bone (width / length): hats, hair and every face part follow;
//   - deforming this character's OWN copy of the skin and eye geometry (jaw, chin, nose, eye size
//     and spacing), always from the original vertices, so changes never accumulate;
//   - attaching small toon parts to the head bone (brows, mouth, ears, facial hair, glasses, extra
//     hairstyles), like the existing hats and accessories.
// The default face (DEFAULT_FACE) changes nothing, so couriers without a face look exactly as before.
import * as THREE from "three";
import { toon } from "./assets.js";
import { P } from "./palette.js";
import { FACE_OPTIONS as F, DEFAULT_FACE, cleanFace } from "../shared/face.js";
import { LOOK_OPTIONS } from "../shared/look.js";

// Head-bone local space (measured from kai.glb): x ±0.21, y 0.04 (chin) → 0.44 (crown), face plane
// z ≈ 0.235, eyes at x ±0.11 y 0.24, nose tip z 0.257 at y ≈ 0.18.
const FACE_Z = 0.236;
const EYE_Y = 0.24;
const MOUTH_Y = 0.105;

const part = (geo, color, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) => {
  const m = new THREE.Mesh(geo, toon(color));
  m.position.set(...pos);
  m.rotation.set(...rot);
  m.scale.set(...scale);
  m.castShadow = false; // tiny parts: no shadow cost
  return m;
};

/** Take a private, deformable copy of the skin and eye geometry the first time a face is applied. */
function prepare(c) {
  if (c._face) return c._face;
  const head = c.p.head;
  const find = (mat) => head.children.find((m) => m.isMesh && m.material?.name === mat);
  const st = { skin: find("skin"), ink: find("ink") };
  for (const k of ["skin", "ink"]) {
    const m = st[k];
    if (!m) continue;
    m.geometry = m.geometry.clone();
    st[`${k}0`] = m.geometry.attributes.position.array.slice();
  }
  // nose: the forward-most vertices near the centre line, below the eyes
  const s0 = st.skin0;
  let tip = { z: -1, y: 0 };
  for (let i = 0; i < s0.length; i += 3) if (s0[i + 2] > tip.z) tip = { z: s0[i + 2], y: s0[i + 1] };
  st.nose = { y: tip.y, z: tip.z - 0.02 };
  let yMin = Infinity;
  for (let i = 1; i < s0.length; i += 3) yMin = Math.min(yMin, s0[i]);
  st.yMin = yMin;
  st.extras = new THREE.Group();
  st.extras.name = "face-extras";
  head.add(st.extras);
  c._face = st;
  return st;
}

function deform(st, f) {
  // skin: jaw taper, chin, nose
  if (st.skin) {
    const a = st.skin.geometry.attributes.position;
    const o = st.skin0;
    const jaw = F.jaw[f.jaw];
    const ns = F.nose[f.nose].s;
    for (let i = 0; i < a.count; i++) {
      let x = o[i * 3];
      let y = o[i * 3 + 1];
      let z = o[i * 3 + 2];
      const isNose = z > FACE_Z - 0.005 && Math.abs(x) < 0.05 && y < EYE_Y - 0.02 && y > MOUTH_Y;
      if (isNose) {
        x *= ns[0];
        y = st.nose.y + (y - st.nose.y) * ns[1];
        z = st.nose.z + (z - st.nose.z) * ns[2];
      } else {
        // below the cheeks the head narrows (or widens) toward the chin
        const t = Math.max(0, Math.min(1, (MOUTH_Y + 0.07 - y) / (MOUTH_Y + 0.07 - st.yMin)));
        const k = Math.pow(t, 1.3);
        x *= 1 + (jaw.x - 1) * k;
        y -= jaw.chin * k * Math.max(0, 1 - Math.abs(x) / 0.16);
      }
      a.setXYZ(i, x, y, z);
    }
    a.needsUpdate = true;
    st.skin.geometry.computeVertexNormals();
    st.skin.geometry.computeBoundingSphere();
  }
  // eyes: scale each eye about its own centre, and move them apart or together
  if (st.ink) {
    const a = st.ink.geometry.attributes.position;
    const o = st.ink0;
    const s = F.eyeSize[f.eyeSize].v;
    const dx = F.eyeSpacing[f.eyeSpacing].v;
    const cx = [0, 0];
    const n = [0, 0];
    for (let i = 0; i < a.count; i++) {
      const side = o[i * 3] < 0 ? 0 : 1;
      cx[side] += o[i * 3];
      n[side]++;
    }
    cx[0] /= n[0] || 1;
    cx[1] /= n[1] || 1;
    for (let i = 0; i < a.count; i++) {
      const side = o[i * 3] < 0 ? 0 : 1;
      const x = cx[side] + (o[i * 3] - cx[side]) * s + (side ? dx : -dx);
      const y = EYE_Y + (o[i * 3 + 1] - EYE_Y) * s;
      a.setXYZ(i, x, y, o[i * 3 + 2]);
    }
    a.needsUpdate = true;
    st.ink.geometry.computeBoundingSphere();
    st.ink.material.color.setHex(F.eyeColor[f.eyeColor].hex);
  }
}

function extras(st, f, look) {
  const g = st.extras;
  g.clear();
  const hair = LOOK_OPTIONS.hair[look.hair]?.hex ?? P.ink;
  const skin = LOOK_OPTIONS.skin[look.skin]?.hex ?? 0xe3b08c;
  const dark = new THREE.Color(skin).multiplyScalar(0.62).getHex();
  const ex = 0.11 + F.eyeSpacing[f.eyeSpacing].v;
  const es = F.eyeSize[f.eyeSize].v;

  // brows
  if (f.brows) {
    const by = EYE_Y + 0.06 + es * 0.02 + (f.brows === 3 ? 0.018 : 0);
    for (const side of [-1, 1]) {
      const x = side * ex;
      if (f.brows === 2 || f.brows === 3) {
        g.add(part(new THREE.TorusGeometry(0.055, 0.011, 4, 10, Math.PI * 0.62), hair, [x, by - 0.045, FACE_Z + 0.006], [0, 0, Math.PI * 0.19]));
      } else {
        const tilt = f.brows === 4 ? side * -0.32 : side * -0.05;
        const thick = f.brows === 5 ? 0.026 : 0.014;
        g.add(part(new THREE.BoxGeometry(0.085, thick, 0.014), hair, [x, by, FACE_Z + 0.006], [0, 0, tilt]));
      }
    }
  }
  // mouth
  if (f.mouth) {
    const y = MOUTH_Y;
    const z = FACE_Z + 0.004;
    if (f.mouth <= 3) {
      const r = [0, 0.032, 0.042, 0.056][f.mouth];
      g.add(part(new THREE.TorusGeometry(r, 0.01, 4, 14, Math.PI * 0.8), P.ink, [0, y + r * 0.62, z], [0, 0, Math.PI * 1.1]));
    } else if (f.mouth === 4) g.add(part(new THREE.BoxGeometry(0.07, 0.012, 0.012), P.ink, [0, y, z]));
    else {
      g.add(part(new THREE.SphereGeometry(0.04, 10, 6), 0xb8606a, [0, y + 0.012, z - 0.006], [0, 0, 0], [1.05, 0.32, 0.4]));
      g.add(part(new THREE.SphereGeometry(0.04, 10, 6), 0xa84f5c, [0, y - 0.012, z - 0.006], [0, 0, 0], [0.95, 0.38, 0.42]));
    }
  }
  // ears
  if (f.ears) {
    const s = [0, 0.8, 1, 1.25][f.ears];
    for (const side of [-1, 1]) g.add(part(new THREE.SphereGeometry(0.045, 10, 8), skin, [side * 0.212, 0.23, 0.0], [0, 0, 0], [0.55 * s, 1.15 * s, 0.85 * s]));
  }
  // facial hair
  if (f.facialHair === 1) g.add(part(new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), dark, [0, 0.16, 0.04], [0, 0, 0], [1.25, 0.9, 1.25]));
  if (f.facialHair === 2 || f.facialHair === 4) g.add(part(new THREE.BoxGeometry(0.1, 0.022, 0.02), hair, [0, MOUTH_Y + 0.035, FACE_Z + 0.01], [0, 0, 0]));
  if (f.facialHair >= 3) {
    const big = f.facialHair === 4;
    g.add(part(new THREE.SphereGeometry(0.17, 14, 8, 0, Math.PI * 2, Math.PI * (big ? 0.5 : 0.6), Math.PI * (big ? 0.5 : 0.4)), hair, [0, big ? 0.17 : 0.15, 0.05], [0, 0, 0], [1.3, big ? 1.2 : 0.9, 1.3]));
  }
  // glasses
  if (f.glasses) {
    const y = EYE_Y + 0.005;
    const z = FACE_Z + 0.014;
    const frame = f.glasses === 4 ? 0x1b1a20 : P.ink;
    for (const side of [-1, 1]) {
      const x = side * ex;
      if (f.glasses === 1) g.add(part(new THREE.TorusGeometry(0.06 * Math.max(1, es * 0.9), 0.011, 6, 18), frame, [x, y, z]));
      else {
        const w = f.glasses === 3 ? 0.13 : 0.12;
        const h = f.glasses === 3 ? 0.07 : 0.085;
        for (const [ox, oy, bw, bh] of [[0, h / 2, w, 0.014], [0, -h / 2, w, 0.012], [-w / 2, 0, 0.012, h], [w / 2, 0, 0.012, h]]) g.add(part(new THREE.BoxGeometry(bw, bh, 0.012), frame, [x + ox, y + oy, z], [0, 0, f.glasses === 3 ? side * 0.18 : 0]));
        if (f.glasses === 4) {
          const lens = part(new THREE.PlaneGeometry(w - 0.01, h - 0.01), 0x1e2230, [x, y, z - 0.002]);
          lens.material = new THREE.MeshBasicMaterial({ color: 0x1e2230, transparent: true, opacity: 0.85 });
          g.add(lens);
        }
      }
    }
    g.add(part(new THREE.BoxGeometry(0.07, 0.012, 0.012), frame, [0, y + 0.012, z]));
  }
  // extra hairstyles (the courier's own short hair stays underneath)
  const hs = f.hairStyle;
  if (hs === 1) g.add(part(new THREE.SphereGeometry(0.235, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), hair, [0, 0.24, -0.005], [0, 0, 0], [0.98, 0.95, 1.0])); // buzz
  if (hs === 2 || hs === 5) {
    const big = hs === 5;
    const n = big ? 22 : 13;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 * (big ? 1 : 1);
      const ring = big ? 0.24 : 0.17;
      const y = big ? 0.38 + Math.sin(i * 1.7) * 0.07 : 0.44 + Math.sin(i * 2.1) * 0.025;
      g.add(part(new THREE.SphereGeometry(big ? 0.1 : 0.075, 8, 6), hair, [Math.cos(a) * ring, y, Math.sin(a) * ring - (big ? 0.03 : 0.02)]));
    }
    if (big) g.add(part(new THREE.SphereGeometry(0.27, 14, 10), hair, [0, 0.4, -0.04], [0, 0, 0], [1.05, 0.85, 1.0]));
  }
  if (hs === 3) {
    g.add(part(new THREE.SphereGeometry(0.24, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), hair, [0, 0.27, -0.01], [0, 0, 0.12], [1.02, 0.9, 1.02]));
    g.add(part(new THREE.BoxGeometry(0.2, 0.05, 0.08), hair, [0.07, 0.43, 0.17], [0.3, 0, -0.25]));
  }
  if (hs === 4) {
    g.add(part(new THREE.SphereGeometry(0.235, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), hair, [0, 0.25, -0.01]));
    g.add(part(new THREE.SphereGeometry(0.07, 10, 8), hair, [0, 0.36, -0.25]));
    g.add(part(new THREE.CapsuleGeometry(0.06, 0.22, 4, 8), hair, [0, 0.2, -0.3], [0.35, 0, 0]));
  }
  if (hs === 6) {
    g.add(part(new THREE.SphereGeometry(0.24, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), hair, [0, 0.24, -0.01]));
    g.add(part(new THREE.BoxGeometry(0.5, 0.5, 0.1), hair, [0, 0.06, -0.21], [0.05, 0, 0]));
    for (const side of [-1, 1]) g.add(part(new THREE.BoxGeometry(0.06, 0.4, 0.2), hair, [side * 0.23, 0.12, -0.04]));
  }
}

/**
 * Apply a face to a Character built with { unique: true }. `rawFace` may be null (no face: the
 * original courier). Returns the cleaned face (or null).
 */
export function applyFace(c, rawFace, look) {
  const f = cleanFace(rawFace);
  if (!f && !c._face) return null; // never customised: leave the original untouched
  const st = prepare(c);
  const face = f || DEFAULT_FACE;
  c.p.head.scale.set(F.headWidth[face.headWidth].v, F.headLength[face.headLength].v, (F.headWidth[face.headWidth].v + 1) / 2);
  deform(st, face);
  extras(st, face, look);
  return f;
}
