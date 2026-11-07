// Builds the OMEN Expo hall from layout.js: floors, walls, ceilings, the glazed concourse, the
// Blender-made tree columns (instanced), LED screens, signage and floor wayfinding.
// Kept cheap: geometry sharing one material is merged, repeated models are instanced, signs are
// canvas textures, and there are no per-column lights (the canopies glow on their own).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { toon, grad, instanced } from "../assets.js";
import { P } from "../palette.js";
import * as L from "./layout.js";

const INK = "#2b2230";
const PAPER = "#fbf3e4";
const hex = (c) => `#${c.toString(16).padStart(6, "0")}`;

/** A canvas texture with crisp text, for signs. */
export function canvasTex(w, h, draw, { repeat = null, nearest = false } = {}) {
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (nearest) t.magFilter = THREE.NearestFilter;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  t.userData.canvas = c;
  return t;
}
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const tmat = (opts) => new THREE.MeshToonMaterial({ gradientMap: grad, ...opts });

function signFace(g, w, h, { band, title, sub, small }) {
  g.fillStyle = PAPER;
  g.fillRect(0, 0, w, h);
  g.fillStyle = band;
  g.fillRect(0, 0, w, h * 0.16);
  g.fillRect(0, h * 0.94, w, h * 0.06);
  g.fillStyle = INK;
  g.textAlign = "center";
  g.font = `800 ${Math.round(h * 0.34)}px 'Bricolage Grotesque', system-ui, sans-serif`;
  g.fillText(title, w / 2, h * 0.56, w * 0.94);
  if (sub) {
    g.font = `${Math.round(h * 0.16)}px 'Patrick Hand', cursive`;
    g.fillText(sub, w / 2, h * 0.8, w * 0.92);
  }
  if (small) {
    g.fillStyle = PAPER;
    g.font = `800 ${Math.round(h * 0.09)}px 'Bricolage Grotesque', system-ui, sans-serif`;
    g.fillText(small, w / 2, h * 0.115, w * 0.9);
  }
  g.strokeStyle = INK;
  g.lineWidth = Math.max(6, h * 0.025);
  g.strokeRect(0, 0, w, h);
}

export function buildVenue(scene) {
  const root = new THREE.Group();
  root.name = "expo-venue";
  scene.add(root);
  const add = (geo, mat, { shadow = false, receive = true, name } = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = receive;
    if (name) m.name = name;
    root.add(m);
    return m;
  };
  const { x0, x1, z0, z1 } = L.BOUNDS;
  const W = x1 - x0;
  const cx = (x0 + x1) / 2;

  // ---------------------------------------------------------------- floors
  // Halls: polished concrete with the factsheet's 9 m utility grid (a small floor box at each node).
  const hallFloor = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#dcd6cb";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(120,110,95,${Math.random() * 0.05})`;
      g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 6, 2 + Math.random() * 6);
    }
    g.strokeStyle = "rgba(95,85,72,.28)";
    g.lineWidth = 2;
    g.strokeRect(1, 1, w - 2, h - 2);
    g.fillStyle = "#a69c8c";
    g.fillRect(0, 0, 14, 14);
  }, { repeat: [W / 9, L.HALL_D / 9] });
  const hall = add(new THREE.PlaneGeometry(W, L.HALL_D).rotateX(-Math.PI / 2).translate(cx, 0, -L.HALL_D / 2), tmat({ map: hallFloor }), { name: "hall-floor" });
  hall.renderOrder = -1;
  // Concourse: warm stone in big tiles.
  const stone = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#eee6d6";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(150,130,100,.35)";
    g.lineWidth = 3;
    g.strokeRect(0, 0, w, h);
    g.strokeRect(w / 2, 0, 0.01, h);
  }, { repeat: [W / 3.2, L.CONCOURSE_D / 3.2] });
  add(new THREE.PlaneGeometry(W, L.CONCOURSE_D).rotateX(-Math.PI / 2).translate(cx, 0, L.CONCOURSE_D / 2), tmat({ map: stone }), { name: "concourse-floor" });

  // Wayfinding lanes: a coloured, arrowed strip from the arrival point into each pavilion.
  const laneGeos = new Map();
  for (const p of L.PAVILIONS) {
    const arrows = canvasTex(64, 128, (g, w, h) => {
      g.fillStyle = hex(p.color);
      g.fillRect(0, 0, w, h);
      g.strokeStyle = "rgba(251,243,228,.9)";
      g.lineWidth = 9;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(12, 78);
      g.lineTo(32, 50);
      g.lineTo(52, 78);
      g.stroke();
    }, { repeat: [1, 1] });
    // from the arrival totem, across the concourse, then into the pavilion
    const pts = [[L.SPAWN.x, 4.5], [p.cx, 2.2], [p.cx, p.open ? -17 : -10]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.5) continue;
      const t = arrows.clone();
      t.needsUpdate = true;
      t.repeat.set(1, len / 2.4);
      const m = add(new THREE.PlaneGeometry(1.8, len).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.92, depthWrite: false }), { receive: false, name: `lane-${p.id}` });
      m.position.set((ax + bx) / 2, 0.02 + p.id * 0.002, (az + bz) / 2);
      m.rotation.y = Math.atan2(ax - bx, az - bz);
      laneGeos.set(`${p.id}-${i}`, m);
    }
  }

  // ---------------------------------------------------------------- walls
  const wallGeos = [];
  const dividerGeos = [];
  const t = L.WALL_T;
  for (const b of L.wallBoxes()) {
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    const isDivider = L.dividers.some((x) => Math.abs((b.x0 + b.x1) / 2 - x) < 0.01) && d > 2;
    const isFront = Math.abs((b.z0 + b.z1) / 2) < 0.01;
    const isSouth = Math.abs((b.z0 + b.z1) / 2 - z1) < 0.01;
    if (isSouth) continue; // the south side is the glazed facade, built below
    // walls that bound the concourse rise to its triple height
    const spansConcourse = !isDivider && (b.z1 > 0.5 || isFront);
    const h = spansConcourse ? L.CONCOURSE_H : L.HALL_H;
    (isDivider ? dividerGeos : wallGeos).push(box(w, h, d, (b.x0 + b.x1) / 2, h / 2, (b.z0 + b.z1) / 2));
  }
  // above each portal: the wall continues from the portal head up to the concourse ceiling
  for (const p of L.portals) wallGeos.push(box(p.x1 - p.x0, L.CONCOURSE_H - L.PORTAL_H, t, (p.x0 + p.x1) / 2, (L.CONCOURSE_H + L.PORTAL_H) / 2, 0));
  // a dark skirting band along the hall walls
  const skirt = [];
  for (const b of L.wallBoxes()) if (Math.abs((b.z0 + b.z1) / 2 - z1) > 0.01) skirt.push(box(b.x1 - b.x0 + 0.04, 0.5, b.z1 - b.z0 + 0.04, (b.x0 + b.x1) / 2, 0.25, (b.z0 + b.z1) / 2));
  add(mergeGeometries(wallGeos), toon(0xd8d2c7), { name: "walls" });
  add(mergeGeometries(dividerGeos), toon(0xc2bbb0), { name: "operable-walls" });
  add(mergeGeometries(skirt), toon(0x6d6458), { name: "skirting" });

  // Portal frames: a teal-black lintel and jambs, so the doorways read from across the hall.
  const frames = [];
  for (const p of L.portals) {
    frames.push(box(p.x1 - p.x0 + 1.2, 0.7, 1.0, (p.x0 + p.x1) / 2, L.PORTAL_H + 0.35, 0));
    frames.push(box(0.6, L.PORTAL_H, 1.0, p.x0 - 0.3, L.PORTAL_H / 2, 0));
    frames.push(box(0.6, L.PORTAL_H, 1.0, p.x1 + 0.3, L.PORTAL_H / 2, 0));
  }
  add(mergeGeometries(frames), toon(P.ink), { name: "portal-frames" });

  // ---------------------------------------------------------------- ceilings
  // Halls: dark, with the 4.5 m hanging-point grid and small fixtures (dimmable lighting).
  const grid = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = "#2a2730";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#3b3743";
    g.lineWidth = 4;
    g.strokeRect(0, 0, w, h);
    g.fillStyle = "#fff4d8";
    g.fillRect(w / 2 - 7, h / 2 - 7, 14, 14);
  }, { repeat: [W / 4.5, L.HALL_D / 4.5] });
  add(new THREE.PlaneGeometry(W, L.HALL_D).rotateX(Math.PI / 2).translate(cx, L.HALL_H, -L.HALL_D / 2), new THREE.MeshBasicMaterial({ map: grid }), { receive: false, name: "hall-ceiling" });
  // Concourse: light coffered ceiling with long light slots.
  const coffer = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = "#f1ebdf";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fffaf0";
    g.fillRect(8, h / 2 - 6, w - 16, 12);
    g.strokeStyle = "#ddd3c2";
    g.lineWidth = 4;
    g.strokeRect(0, 0, w, h);
  }, { repeat: [W / 6, L.CONCOURSE_D / 6] });
  add(new THREE.PlaneGeometry(W, L.CONCOURSE_D).rotateX(Math.PI / 2).translate(cx, L.CONCOURSE_H, L.CONCOURSE_D / 2), new THREE.MeshBasicMaterial({ map: coffer }), { receive: false, name: "concourse-ceiling" });

  // ---------------------------------------------------------------- the daylit glazed facade
  const sky = canvasTex(4, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#b9c6e4");
    gr.addColorStop(0.7, "#f6dcc0");
    gr.addColorStop(1, "#f6c7a1");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  add(new THREE.PlaneGeometry(W, L.CONCOURSE_H).rotateY(Math.PI).translate(cx, L.CONCOURSE_H / 2, z1 + 0.35), new THREE.MeshBasicMaterial({ map: sky }), { receive: false, name: "glazing" });
  const mullions = [];
  for (let x = x0; x <= x1 + 0.01; x += 6) mullions.push(box(0.22, L.CONCOURSE_H, 0.3, x, L.CONCOURSE_H / 2, z1));
  for (const y of [0.15, 5.5, 11]) mullions.push(box(W, 0.2, 0.3, cx, y, z1));
  add(mergeGeometries(mullions), toon(P.ink), { name: "mullions" });

  // ---------------------------------------------------------------- tree columns (Blender, instanced)
  const mats = L.COLUMNS.map((c) => new THREE.Matrix4().makeTranslation(c.x, 0, c.z));
  const cols = instanced("tree_column", mats, { shadows: true });
  cols.name = "tree-columns";
  root.add(cols);

  // ---------------------------------------------------------------- signage
  const signs = [];
  const sign = (wM, hM, px, opts, x, y, z, ry = 0, { both = false } = {}) => {
    const tex = canvasTex(Math.round(px), Math.round((px * hM) / wM), (g, w, h) => signFace(g, w, h, opts));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), new THREE.MeshBasicMaterial({ map: tex, side: both ? THREE.DoubleSide : THREE.FrontSide }));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    root.add(m);
    signs.push(m);
    return m;
  };
  for (const p of L.PAVILIONS) {
    const band = hex(p.color);
    // over the portal, facing the concourse
    sign(16, 3.2, 1024, { band, title: `${p.name}`, sub: p.open ? p.theme : `${p.theme} · opening soon`, small: p.open ? "OPEN NOW" : "COMING NEXT" }, p.cx, L.PORTAL_H + 2.6, 0.62);
    // hanging inside the pavilion, readable from both sides
    const hs = sign(10, 2.6, 768, { band, title: `${p.id}`, sub: p.theme }, p.cx, 8.2, -9, 0, { both: true });
    const rods = mergeGeometries([box(0.05, 2.6, 0.05, -4, 2.6, 0), box(0.05, 2.6, 0.05, 4, 2.6, 0)]); // up to the ceiling grid
    const rodMesh = new THREE.Mesh(rods, toon(P.ink));
    rodMesh.position.copy(hs.position).setY(8.2);
    root.add(rodMesh);
    if (!p.open) {
      // an honest floor marker where the pavilion's exhibits will go
      const tex = canvasTex(1024, 512, (g, w, h) => {
        g.fillStyle = "rgba(251,243,228,.0)";
        g.clearRect(0, 0, w, h);
        g.strokeStyle = band;
        g.lineWidth = 14;
        g.setLineDash([46, 30]);
        g.strokeRect(20, 20, w - 40, h - 40);
        g.fillStyle = band;
        g.textAlign = "center";
        g.font = "800 92px 'Bricolage Grotesque', system-ui, sans-serif";
        g.fillText("OPENING SOON", w / 2, h / 2 + 4);
        g.font = "52px 'Patrick Hand', cursive";
        g.fillText(p.theme, w / 2, h / 2 + 84);
      });
      const m = add(new THREE.PlaneGeometry(22, 11).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), { receive: false, name: `soon-${p.id}` });
      m.position.set(p.cx, 0.03, -26);
    }
  }

  // Arrival totem: three arrows, one per pavilion, plus the way back to the village.
  const totemTex = canvasTex(512, 900, (g, w, h) => {
    g.fillStyle = PAPER;
    g.fillRect(0, 0, w, h);
    g.fillStyle = INK;
    g.fillRect(0, 0, w, 120);
    g.fillStyle = PAPER;
    g.textAlign = "center";
    g.font = "800 64px 'Bricolage Grotesque', system-ui, sans-serif";
    g.fillText("OMEN EXPO", w / 2, 82);
    const rows = [["←", "1", "Main Stage", hex(L.PAVILIONS[0].color)], ["↑", "2", "Ads & Expo", hex(L.PAVILIONS[1].color)], ["→", "3", "Judging & Lounge", hex(L.PAVILIONS[2].color)], ["→", "", "Blockhaven village", "#5f7d99"]];
    rows.forEach(([a, n, label, col], i) => {
      const y = 170 + i * 175;
      g.fillStyle = col;
      g.fillRect(26, y, w - 52, 140);
      g.fillStyle = PAPER;
      g.textAlign = "left";
      g.font = "800 92px 'Bricolage Grotesque', system-ui, sans-serif";
      g.fillText(a, 46, y + 102);
      g.font = `800 ${n ? 58 : 44}px 'Bricolage Grotesque', system-ui, sans-serif`;
      g.fillText(n ? `${n} · ${label}` : label, 150, y + 92, w - 190);
    });
  });
  const totem = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3.87), new THREE.MeshBasicMaterial({ map: totemTex }));
  face.position.set(0, 2.6, 0.21);
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 4.3, 0.4).translate(0, 2.4, 0), toon(P.ink));
  back.castShadow = true;
  const face2 = face.clone();
  face2.position.z = -0.21;
  face2.rotation.y = Math.PI; // readable from the halls too
  totem.add(back, face, face2);
  totem.position.set(L.SPAWN.x, 0, 4.5);
  totem.rotation.y = 0; // faces south, toward arriving visitors
  root.add(totem);

  // The way back to Blockhaven: a glowing doorway on the concourse's east wall.
  const door = new THREE.Group();
  const doorGlow = new THREE.Mesh(new THREE.PlaneGeometry(4, 5.2), new THREE.MeshBasicMaterial({ color: 0xf6c7a1 }));
  doorGlow.position.set(0, 2.6, 0.05);
  const doorFrame = new THREE.Mesh(mergeGeometries([box(5, 0.6, 0.6, 0, 5.5, 0), box(0.6, 5.8, 0.6, -2.3, 2.9, 0), box(0.6, 5.8, 0.6, 2.3, 2.9, 0)]), toon(P.slate));
  door.add(doorGlow, doorFrame);
  const doorSign = sign(5, 1.3, 512, { band: "#5f7d99", title: "Blockhaven", sub: "back to the village" }, 0, 7, 0.1);
  root.remove(doorSign);
  door.add(doorSign);
  door.position.set(L.BOUNDS.x1 - 0.35, 0, L.VILLAGE_DOOR.z);
  door.rotation.y = -Math.PI / 2;
  root.add(door);

  // Concourse seating, merged into one mesh.
  const seats = [];
  for (const [x, z] of [[-48, 15], [-20, 16], [16, 16], [42, 15], [62, 16]]) {
    seats.push(box(4.2, 0.5, 1.1, x, 0.45, z), box(4.2, 0.6, 0.25, x, 0.95, z + 0.45), box(0.3, 0.45, 0.9, x - 1.8, 0.22, z), box(0.3, 0.45, 0.9, x + 1.8, 0.22, z));
  }
  add(mergeGeometries(seats), toon(P.wood), { shadow: true, name: "seating" });

  // ---------------------------------------------------------------- hall lighting (as photographed)
  // Rows of black lighting truss under the dark ceiling, each with moving-head fixtures and short
  // blue LED bars. Three instanced/merged meshes for the whole venue; no real lights.
  const trussY = 11.35;
  const rowsZ = [-6, -15, -24, -33, -42];
  const beams = [];
  for (const z of rowsZ) beams.push(box(W - 1, 0.18, 0.18, cx, trussY, z), box(W - 1, 0.18, 0.18, cx, trussY + 0.42, z), box(W - 1, 0.05, 0.05, cx, trussY + 0.21, z - 0.12));
  add(mergeGeometries(beams), toon(0x15131a), { name: "ceiling-truss" });
  const fixtureMats = [];
  const barMats = [];
  for (const z of rowsZ)
    for (let x = x0 + 3; x < x1 - 2; x += 4.5) {
      fixtureMats.push(new THREE.Matrix4().makeTranslation(x, trussY - 0.32, z));
      if (Math.round((x - x0) / 4.5) % 2 === 0) barMats.push(new THREE.Matrix4().makeTranslation(x + 2.25, trussY - 0.12, z));
    }
  const fixtureGeo = mergeGeometries([new THREE.CylinderGeometry(0.16, 0.2, 0.36, 8), box(0.34, 0.06, 0.22, 0, 0.22, 0)]);
  const fixtures = new THREE.InstancedMesh(fixtureGeo, toon(0x24212b), fixtureMats.length);
  fixtureMats.forEach((m, i) => fixtures.setMatrixAt(i, m));
  fixtures.name = "ceiling-fixtures";
  root.add(fixtures);
  const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0x4f63ff, toneMapped: false }), barMats.length);
  barMats.forEach((m, i) => bars.setMatrixAt(i, m));
  bars.name = "ceiling-led-bars";
  root.add(bars);

  // Indigo frieze with a mandala pattern along the top of the hall walls, and "OMEN · MUMBAI"
  // signs above it: the halls' look during the event, with OMEN's own name.
  const frieze = canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = "#1d2f8f";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(140,170,255,.75)";
    g.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      const cx2 = w / 8 + (i * w) / 4;
      for (let r = 12; r < 56; r += 11) {
        g.beginPath();
        g.arc(cx2, h / 2, r, 0, Math.PI * 2);
        g.stroke();
      }
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        g.beginPath();
        g.ellipse(cx2 + Math.cos(a) * 34, h / 2 + Math.sin(a) * 34, 12, 5, a, 0, Math.PI * 2);
        g.stroke();
      }
    }
  }, { repeat: [1, 1] });
  const friezeRuns = [
    { x: cx, z: -L.HALL_D + 0.32, len: W, ry: 0 }, // north wall, facing south
    ...L.PAVILIONS.map((p) => ({ x: p.cx, z: -0.32, len: p.w, ry: Math.PI })), // inside the front wall, facing north
  ];
  for (const f of friezeRuns) {
    const tx = frieze.clone();
    tx.needsUpdate = true;
    tx.repeat.set(f.len / 9, 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(f.len, 2.2), new THREE.MeshBasicMaterial({ map: tx }));
    m.position.set(f.x, 7.4, f.z);
    m.rotation.y = f.ry;
    m.name = "mandala-frieze";
    root.add(m);
  }
  const mumbai = (x, z, ry) => {
    const tex = canvasTex(768, 288, (g, w, h) => {
      g.fillStyle = "#1d2f8f";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#f3a65a";
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        g.beginPath();
        g.ellipse(140 + Math.cos(a) * 44, h / 2 + Math.sin(a) * 44, 34, 15, a, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = "#fbf3e4";
      g.beginPath();
      g.arc(140, h / 2, 26, 0, Math.PI * 2);
      g.fill();
      g.textAlign = "left";
      g.font = "800 46px 'Bricolage Grotesque', system-ui, sans-serif";
      g.fillText("OMEN", 250, h / 2 - 14);
      g.font = "800 92px 'Bricolage Grotesque', system-ui, sans-serif";
      g.fillText("MUMBAI", 245, h / 2 + 70, w - 270);
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), new THREE.MeshBasicMaterial({ map: tex }));
    m.position.set(x, 9.9, z);
    m.rotation.y = ry;
    m.name = "mumbai-sign";
    root.add(m);
  };
  mumbai(L.PAVILIONS[0].cx - 17, -L.HALL_D + 0.34, 0);
  mumbai(L.PAVILIONS[1].cx + 20, -L.HALL_D + 0.34, 0);
  mumbai(L.PAVILIONS[2].cx, -L.HALL_D + 0.34, 0);

  // The white arrival arch (the sweeping arches at the halls' entrance), framing the spawn point.
  const archMat = toon(0xf4f1ea);
  const arch = new THREE.Group();
  for (const [r, z] of [[7.5, 17.2], [7.5, 15.8]]) {
    const a = new THREE.Mesh(new THREE.TorusGeometry(r, 0.42, 10, 40, Math.PI), archMat);
    a.position.set(L.SPAWN.x, 0, z);
    a.castShadow = true;
    arch.add(a);
  }
  arch.add(new THREE.Mesh(box(2.0, 0.3, 1.4, L.SPAWN.x - 7.5, 0.15, 16.5), toon(0x9e9384)), new THREE.Mesh(box(2.0, 0.3, 1.4, L.SPAWN.x + 7.5, 0.15, 16.5), toon(0x9e9384)));
  arch.name = "arrival-arch";
  root.add(arch);

  // ---------------------------------------------------------------- LED screens (live content painted by the app)
  const screens = [];
  const screen = (wM, hM, x, y, z, ry, name) => {
    const tex = canvasTex(1024, Math.round((1024 * hM) / wM), (g, w, h) => {
      g.fillStyle = "#14121a";
      g.fillRect(0, 0, w, h);
    });
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(wM + 0.5, hM + 0.5, 0.35).translate(0, 0, -0.2), toon(0x17151c));
    const g = new THREE.Group();
    g.add(bezel, glass);
    g.position.set(x, y, z);
    g.rotation.y = ry;
    g.name = name;
    root.add(g);
    screens.push({ name, tex, canvas: tex.userData.canvas, group: g, w: wM, h: hM });
  };
  // On the concourse side of the front wall, between the portals, above head height.
  const between = (a, b) => (L.portals[a].x1 + L.portals[b].x0) / 2;
  screen(20, 8.4, between(0, 1), 8.4, 0.75, 0, "led-west");
  screen(20, 8.4, between(1, 2), 8.4, 0.75, 0, "led-east");
  // A long banner screen high over the arrival point.
  screen(30, 3.4, L.PAVILIONS[1].cx, 14.1, 0.75, 0, "led-banner");

  return { root, screens, signs, door, totem };
}
