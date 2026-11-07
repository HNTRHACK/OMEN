// The orange festival pavilion (Pavilion 2, straight ahead of the arrival point): four big orange
// posts and beams, a draped canopy of fabric swags (orange, gold, teal, magenta, red), rows of warm
// festival lights, a fringe of pointed drapes along the front, banners, counters with screens,
// seating, potted palms and warm uplight washes. Original geometry, built to read like the
// photographed festival tent; no real lights: bulbs and washes are emissive/additive.
// Draw calls: frame 1, fabric 1 (vertex colours), furniture 1, bulbs 1, glows 1, banners/screens ~6.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { grad } from "../assets.js";
import * as L from "./layout.js";
import { canvasTex } from "./venue.js";

const C = new THREE.Color();
function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  C.set(hex).convertSRGBToLinear();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([C.r, C.g, C.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.deleteAttribute("uv");
  return g;
}
const bx = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cyl = (r1, r2, h, x, y, z, n = 12) => new THREE.CylinderGeometry(r1, r2, h, n).translate(x, y, z);

const ORANGE = "#e2581e";
const FABRIC = ["#e2581e", "#f2b632", "#1f8f8a", "#c2306e", "#d63a2c", "#f08a2c", "#2c6fb0"];

/** A swag of fabric between two beams: a strip across x, sagging in the middle, gently rippled. */
function swag(x0, x1, z, width, top, sag, seed) {
  const segX = 28;
  const segZ = 3;
  const g = new THREE.PlaneGeometry(x1 - x0, width, segX, segZ).rotateX(Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const zz = p.getZ(i);
    const t = (x + (x1 - x0) / 2) / (x1 - x0); // 0..1 across
    const droop = -sag * Math.sin(Math.PI * t) - Math.abs(zz) * 0.25; // the centre hangs lowest; edges curl up
    const ripple = Math.sin(t * Math.PI * 7 + seed) * 0.06;
    p.setXYZ(i, x + (x0 + x1) / 2, top + droop + ripple, zz + z);
  }
  g.computeVertexNormals();
  return g;
}

export function buildTent(scene) {
  const T = L.TENT;
  const root = new THREE.Group();
  root.name = "festival-pavilion";
  scene.add(root);
  const hw = T.w / 2;
  const hd = T.d / 2;
  const X0 = T.x - hw;
  const X1 = T.x + hw;
  const Z0 = T.z - hd; // back (north)
  const Z1 = T.z + hd; // front (south), facing the arrival portal

  // ---------------------------------------------------------------- the orange frame
  const frame = [];
  for (const p of L.tentPosts()) frame.push(colored(bx(T.post, T.h, T.post, p.x, T.h / 2, p.z), ORANGE));
  const bh = 0.75;
  frame.push(colored(bx(T.w, bh, T.post, T.x, T.h - bh / 2, Z1 - T.post / 2), ORANGE)); // front beam
  frame.push(colored(bx(T.w, bh, T.post, T.x, T.h - bh / 2, Z0 + T.post / 2), ORANGE)); // back beam
  frame.push(colored(bx(T.post, bh, T.d, X0 + T.post / 2, T.h - bh / 2, T.z), ORANGE)); // sides
  frame.push(colored(bx(T.post, bh, T.d, X1 - T.post / 2, T.h - bh / 2, T.z), ORANGE));
  // darker trim lines and base plates, so the frame reads as built, not a flat box
  for (const z of [Z1 - T.post / 2, Z0 + T.post / 2]) frame.push(colored(bx(T.w + 0.04, 0.08, T.post + 0.04, T.x, T.h - bh, z), "#a83a12"));
  for (const p of L.tentPosts()) frame.push(colored(bx(T.post + 0.3, 0.12, T.post + 0.3, p.x, 0.06, p.z), "#5a3a2a"));
  // ---------------------------------------------------------------- the draped canopy
  const fabric = [];
  const rows = 9;
  for (let i = 0; i < rows; i++) {
    const z = Z0 + T.post + ((i + 0.5) * (T.d - 2 * T.post)) / rows;
    fabric.push(colored(swag(X0 + T.post, X1 - T.post, z, (T.d - 2 * T.post) / rows + 0.08, T.canopy + 0.35, 0.55 + (i % 2) * 0.15, i * 1.7), FABRIC[i % FABRIC.length]));
  }
  // a fringe of pointed drapes hanging from the front and side beams (the tent's festive valance)
  const fringe = (ax, az, bxp, bz, n, len) => {
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      const x0 = ax + (bxp - ax) * t0;
      const z0 = az + (bz - az) * t0;
      const x1 = ax + (bxp - ax) * t1;
      const z1 = az + (bz - az) * t1;
      const top = T.h - bh;
      const tri = new THREE.BufferGeometry();
      const l = len * (0.75 + 0.25 * Math.sin(k * 2.3) ** 2);
      tri.setAttribute("position", new THREE.Float32BufferAttribute([x0, top, z0, x1, top, z1, (x0 + x1) / 2, top - l, (z0 + z1) / 2], 3));
      tri.computeVertexNormals();
      fabric.push(colored(tri, FABRIC[(k * 3) % FABRIC.length]));
    }
  };
  fringe(X0 + T.post, Z1 - T.post - 0.02, X1 - T.post, Z1 - T.post - 0.02, 16, 1.45);
  fringe(X0 + T.post, Z1 - 0.02, X1 - T.post, Z1 - 0.02, 16, 1.15);
  fringe(X0 - 0.02, Z1 - T.post, X0 - 0.02, Z0 + T.post, 11, 0.8);
  fringe(X1 + 0.02, Z1 - T.post, X1 + 0.02, Z0 + T.post, 11, 0.8);
  const fabricMesh = new THREE.Mesh(mergeGeometries(fabric), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: grad, side: THREE.DoubleSide, emissive: 0x3a1a08, emissiveIntensity: 0.6 }));
  fabricMesh.name = "tent-canopy";
  fabricMesh.receiveShadow = true;
  root.add(fabricMesh);

  // ---------------------------------------------------------------- festival lights
  // Warm bulbs strung along each swag and along the front beam; one instanced mesh, plus one
  // Points layer of soft additive glows. Nothing here is a real light source.
  const bulbs = [];
  for (let i = 0; i <= rows; i++) {
    const z = Z0 + T.post + (i * (T.d - 2 * T.post)) / rows;
    const n = 22;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = X0 + T.post + t * (T.w - 2 * T.post);
      bulbs.push([x, T.canopy + 0.15 - 0.65 * Math.sin(Math.PI * t) - 0.12, z]);
    }
  }
  for (let k = 0; k <= 26; k++) bulbs.push([X0 + 0.3 + (k * (T.w - 0.6)) / 26, T.h - bh - 0.12 - 0.25 * Math.sin((Math.PI * k) / 26), Z1 + 0.05]);
  const bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe2a8, toneMapped: false }), bulbs.length);
  bulbs.forEach(([x, y, z], i) => bulbMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y, z)));
  bulbMesh.name = "tent-bulbs";
  root.add(bulbMesh);
  const glowTex = canvasTex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, "rgba(255,236,190,1)");
    gr.addColorStop(0.25, "rgba(255,190,110,.55)");
    gr.addColorStop(1, "rgba(255,160,80,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  const glowGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(bulbs.flat(), 3));
  const glows = new THREE.Points(glowGeo, new THREE.PointsMaterial({ map: glowTex, size: 0.9, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  glows.name = "tent-glows";
  root.add(glows);

  // warm uplight washes on the posts (an additive gradient plane on each inner face)
  const washTex = canvasTex(32, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, h, 0, 0);
    gr.addColorStop(0, "rgba(255,190,110,.75)");
    gr.addColorStop(1, "rgba(255,170,90,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  const washMat = new THREE.MeshBasicMaterial({ map: washTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide });
  const washes = [];
  for (const p of L.tentPosts()) {
    const fx = Math.sign(T.x - p.x);
    const fz = Math.sign(T.z - p.z);
    for (const [nx, nz] of [[fx, 0], [0, fz]]) {
      const plane = new THREE.PlaneGeometry(T.post * 0.95, 4.2);
      plane.rotateY(nx !== 0 ? (nx > 0 ? Math.PI / 2 : -Math.PI / 2) : nz > 0 ? 0 : Math.PI);
      plane.translate(p.x + nx * (T.post / 2 + 0.01), 2.1, p.z + nz * (T.post / 2 + 0.01));
      washes.push(plane);
    }
    washes.push(new THREE.CircleGeometry(0.55, 16).rotateX(-Math.PI / 2).translate(p.x + fx * 0.7, 0.025, p.z + fz * 0.7)); // floor spill
  }
  const washMesh = new THREE.Mesh(mergeGeometries(washes), washMat);
  washMesh.name = "tent-uplights";
  root.add(washMesh);

  // ---------------------------------------------------------------- banners
  const banner = (w, h, draw, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: canvasTex(Math.round(256 * w), Math.round(256 * h), draw), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    root.add(m);
    return m;
  };
  const title = (text, sub, bg, fg) => (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#f2b632";
    for (let x = 0; x < w; x += 40) {
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x + 20, h - 22);
      g.lineTo(x + 40, h);
      g.fill();
    }
    g.fillStyle = fg;
    g.textAlign = "center";
    g.font = `800 ${Math.round(h * 0.42)}px 'Bricolage Grotesque', system-ui, sans-serif`;
    g.fillText(text, w / 2, h * (sub ? 0.5 : 0.62), w * 0.92);
    if (sub) {
      g.font = `${Math.round(h * 0.2)}px 'Patrick Hand', cursive`;
      g.fillText(sub, w / 2, h * 0.75, w * 0.9);
    }
  };
  banner(9, 0.75, title("FESTIVAL PAVILION", "", "#a83a12", "#fff4e0"), T.x, T.h - bh / 2, Z1 + 0.01); // on the front beam
  for (const sx of [-1, 1]) {
    const vert = (g, w, h) => {
      g.fillStyle = sx < 0 ? "#c2306e" : "#1f8f8a";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#f2b632";
      g.fillRect(0, 0, w, h * 0.06);
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(w / 2, h * 0.9);
      g.lineTo(w, h);
      g.fillStyle = "#14121a";
      g.fill();
      g.fillStyle = "#fff4e0";
      g.textAlign = "center";
      g.font = `800 ${Math.round(w * 0.22)}px 'Bricolage Grotesque', system-ui, sans-serif`;
      (sx < 0 ? ["OMEN", "MUMBAI"] : ["MEET", "BUILD", "SHIP"]).forEach((l, i) => g.fillText(l, w / 2, h * 0.22 + i * w * 0.3, w * 0.9));
    };
    banner(1.1, 2.6, vert, T.x + sx * (hw - 2.2), T.h - bh - 1.45, Z1 - 0.1);
  }

  // ---------------------------------------------------------------- inside: counters, screens, seating, plants
  const furn = [];
  const screens = [];
  for (const c of T.counters) {
    furn.push(colored(bx(c.w, 1.0, c.d, c.x, 0.5, c.z), "#3a2a22"));
    furn.push(colored(bx(c.w + 0.1, 0.06, c.d + 0.1, c.x, 1.03, c.z), "#f1e6d2"));
    furn.push(colored(bx(c.w > c.d ? c.w : 0.05, 0.18, c.w > c.d ? 0.05 : c.d, c.x + (c.w > c.d ? 0 : (c.x < T.x ? 0.47 : -0.47)), 0.85, c.z + (c.w > c.d ? 0.47 : 0)), ORANGE)); // orange kick band facing in
  }
  // a big screen on a stand behind the back counter, and a small one on each side counter
  const screenTex = canvasTex(512, 288, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, "#2a1a3a");
    gr.addColorStop(1, "#5a1f2e");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#f2b632";
    g.textAlign = "center";
    g.font = "800 54px 'Bricolage Grotesque', system-ui, sans-serif";
    g.fillText("FESTIVAL PAVILION", w / 2, h * 0.45, w * 0.9);
    g.fillStyle = "#fff4e0";
    g.font = "30px 'Patrick Hand', cursive";
    g.fillText("meet-ups · demos · chai", w / 2, h * 0.68);
  });
  const screen = (w, h, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    root.add(m);
    screens.push(m);
    furn.push(colored(bx(w + 0.12, h + 0.12, 0.08, 0, 0, -0.05).applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z)), "#121018"));
  };
  const back = T.counters[0];
  screen(3.2, 1.8, back.x, 2.4, back.z - 0.75, 0);
  furn.push(colored(cyl(0.06, 0.06, 1.5, back.x - 1.2, 0.75, back.z - 0.8), "#2b2230"), colored(cyl(0.06, 0.06, 1.5, back.x + 1.2, 0.75, back.z - 0.8), "#2b2230"));
  for (const c of T.counters.slice(1)) {
    const face = c.x < T.x ? Math.PI / 2 : -Math.PI / 2;
    screen(0.9, 0.55, c.x, 1.45, c.z, face);
  }
  // seating: round tables with four stools
  for (const t of T.tables) {
    furn.push(colored(cyl(0.55, 0.55, 0.05, t.x, 0.76, t.z, 20), "#f1e6d2"), colored(cyl(0.06, 0.08, 0.74, t.x, 0.37, t.z, 8), "#2b2230"), colored(cyl(0.3, 0.3, 0.03, t.x, 0.015, t.z, 14), "#2b2230"));
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const sx = t.x + Math.cos(a) * 0.9;
      const sz = t.z + Math.sin(a) * 0.9;
      furn.push(colored(cyl(0.21, 0.21, 0.08, sx, 0.47, sz, 14), FABRIC[k]), colored(cyl(0.035, 0.035, 0.45, sx, 0.22, sz, 6), "#2b2230"));
    }
  }
  // potted palms at the corners, like the ones beside the photographed tent
  for (const p of T.plants) {
    furn.push(colored(cyl(0.38, 0.3, 0.6, p.x, 0.3, p.z, 14), "#b98a5e"), colored(cyl(0.06, 0.09, 1.6, p.x, 1.3, p.z, 6), "#6b4a2a"));
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const leaf = new THREE.BoxGeometry(1.05, 0.03, 0.22).translate(0.52, 0, 0).rotateZ(-0.55 - (k % 2) * 0.2).rotateY(a).translate(p.x, 2.05, p.z);
      furn.push(colored(leaf, k % 2 ? "#3f7a3c" : "#5e9a5b"));
    }
  }
  const furnMesh = new THREE.Mesh(mergeGeometries(furn), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: grad }));
  furnMesh.name = "tent-furniture";
  furnMesh.castShadow = true;
  furnMesh.receiveShadow = true;
  root.add(furnMesh);

  const frameMesh = new THREE.Mesh(mergeGeometries(frame), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: grad, emissive: 0x2a0e00, emissiveIntensity: 0.5 }));
  frameMesh.name = "tent-frame";
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  root.add(frameMesh);

  return { root, glows, bulbs: bulbMesh, screens };
}
