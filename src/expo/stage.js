// The Main Stage (Pavilion 1): a raised deck with side steps, a giant LED wall flanked by two
// portrait screens, a lighting truss with fixtures, two podiums, floral signage panels and rows of
// audience chairs. Built from the description in OMEN's venue brief, in OMEN's own style; it is
// not traced from a photograph. Chairs are one InstancedMesh; truss and deck are merged meshes.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { toon } from "../assets.js";
import { P } from "../palette.js";
import * as L from "./layout.js";
import { canvasTex } from "./venue.js";

const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** An original floral pattern: marigold and lotus motifs on mustard, in a pointed-arch frame. */
export function floral(g, w, h, title) {
  g.fillStyle = "#e9b949";
  g.fillRect(0, 0, w, h);
  const rnd = (() => {
    let s = 7;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  })();
  const flower = (x, y, r, petals, c1, c2) => {
    g.fillStyle = c1;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2;
      g.beginPath();
      g.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.5, r * 0.26, a, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = c2;
    g.beginPath();
    g.arc(x, y, r * 0.3, 0, Math.PI * 2);
    g.fill();
  };
  for (let i = 0; i < 46; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    if (Math.abs(x - w / 2) < w * 0.3 && y > h * 0.18 && y < h * 0.86) continue; // keep the arch clear
    g.strokeStyle = "#41744a";
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + 30 * (rnd() - 0.5), y + 40, x + 50 * (rnd() - 0.5), y + 80);
    g.stroke();
    flower(x, y, 26 + rnd() * 30, 8, rnd() > 0.5 ? "#c8473d" : "#e05a2c", "#f6e3b0");
  }
  // pointed arch with the panel's title
  g.fillStyle = "#fbf3e4";
  g.beginPath();
  g.moveTo(w * 0.2, h * 0.86);
  g.lineTo(w * 0.2, h * 0.34);
  g.quadraticCurveTo(w * 0.2, h * 0.2, w / 2, h * 0.14);
  g.quadraticCurveTo(w * 0.8, h * 0.2, w * 0.8, h * 0.34);
  g.lineTo(w * 0.8, h * 0.86);
  g.closePath();
  g.fill();
  g.strokeStyle = "#2b2230";
  g.lineWidth = 8;
  g.stroke();
  g.fillStyle = "#2b2230";
  g.textAlign = "center";
  g.font = "800 64px 'Bricolage Grotesque', system-ui, sans-serif";
  title.split(" ").forEach((word, i) => g.fillText(word, w / 2, h * 0.42 + i * 78, w * 0.54));
}

/** A rectangular box truss between two points along x, as merged thin members. */
function trussX(x0, x1, y, z, s = 0.5) {
  const g = [];
  const len = x1 - x0;
  for (const [dy, dz] of [[0, 0], [s, 0], [0, s], [s, s]]) g.push(box(len, 0.06, 0.06, (x0 + x1) / 2, y + dy, z + dz));
  const n = Math.round(len / s);
  for (let i = 0; i <= n; i++) {
    const x = x0 + (i * len) / n;
    g.push(box(0.05, s, 0.05, x, y + s / 2, z), box(0.05, s, 0.05, x, y + s / 2, z + s));
    if (i < n) {
      const d = new THREE.BoxGeometry(0.04, Math.hypot(s, len / n), 0.04).rotateZ(Math.atan2(len / n, s) * (i % 2 ? 1 : -1));
      g.push(d.clone().translate(x + len / n / 2, y + s / 2, z), d.translate(x + len / n / 2, y + s / 2, z + s));
    }
  }
  return g;
}
function trussTower(x, z, h, s = 0.5) {
  const g = [];
  for (const [dx, dz] of [[0, 0], [s, 0], [0, s], [s, s]]) g.push(box(0.06, h, 0.06, x + dx - s / 2, h / 2, z + dz - s / 2));
  for (let y = 0.5; y < h; y += 1) g.push(box(s, 0.05, 0.05, x, y, z - s / 2), box(s, 0.05, 0.05, x, y, z + s / 2), box(0.05, 0.05, s, x - s / 2, y, z), box(0.05, 0.05, s, x + s / 2, y, z));
  return g;
}

export function buildStage(scene) {
  const S = L.STAGE;
  const root = new THREE.Group();
  root.name = "main-stage";
  scene.add(root);
  const add = (geo, mat, { shadow = true, receive = true, name } = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = receive;
    if (name) m.name = name;
    root.add(m);
    return m;
  };

  // Deck, its dark skirt with an indigo edge light, and the side steps.
  const sw = S.x1 - S.x0;
  const sd = S.z1 - S.z0;
  const scx = (S.x0 + S.x1) / 2;
  const scz = (S.z0 + S.z1) / 2;
  add(box(sw, S.h, sd, scx, S.h / 2, scz), toon(0x1f1c25), { name: "stage-deck" });
  add(box(sw, 0.04, sd, scx, S.h + 0.02, scz), toon(0x34303c), { shadow: false, name: "stage-top" });
  add(box(sw, 0.08, 0.06, scx, S.h - 0.12, S.z1 + 0.02), toon(0x6f7dff, 0x6f7dff, 1.4), { shadow: false, name: "stage-edge-light" });
  const t = S.steps;
  const steps = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const h = (S.h * (i + 1)) / n;
    const w = (t.x1 - t.x0) / n;
    steps.push(box(w, h, t.z1 - t.z0, t.x0 + w * (i + 0.5), h / 2, (t.z0 + t.z1) / 2));
  }
  add(mergeGeometries(steps), toon(0x34303c), { name: "stage-steps" });

  // The giant LED wall and two portrait side screens (painted live by the app).
  const screens = [];
  const screenMesh = (w, h, x, y, z, ry, name) => {
    const tex = canvasTex(1024, Math.round((1024 * h) / w), (g, cw, ch) => {
      g.fillStyle = "#121018";
      g.fillRect(0, 0, cw, ch);
    });
    const g = new THREE.Group();
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, h + 0.4, 0.4).translate(0, 0, -0.22), toon(0x121018));
    bezel.castShadow = true;
    g.add(bezel, glass);
    g.position.set(x, y, z);
    g.rotation.y = ry;
    g.name = name;
    root.add(g);
    screens.push({ name, tex, canvas: tex.userData.canvas, group: g, w, h });
  };
  const sc = S.screen;
  screenMesh(sc.w, sc.h, sc.x, sc.y0 + sc.h / 2, sc.z + 0.45, 0, "stage-led");
  screenMesh(4.2, 7, sc.x - sc.w / 2 - 3.2, S.h + 4.6, sc.z + 1.6, 0.35, "stage-led-left");
  screenMesh(4.2, 7, sc.x + sc.w / 2 + 3.2, S.h + 4.6, sc.z + 1.6, -0.35, "stage-led-right");

  // Lighting truss: two towers and a span over the stage front, with fixtures and an LED bar.
  const tr = S.truss;
  const truss = [...trussX(tr.x0, tr.x1, tr.y, tr.z - 0.25), ...trussTower(tr.x0, tr.z, tr.y + 0.5), ...trussTower(tr.x1, tr.z, tr.y + 0.5)];
  add(mergeGeometries(truss), toon(0x9aa0a8), { name: "stage-truss" });
  add(box(tr.x1 - tr.x0 - 1, 0.12, 0.12, (tr.x0 + tr.x1) / 2, tr.y - 0.1, tr.z), toon(0x6f7dff, 0x6f7dff, 1.6), { shadow: false, name: "truss-led" });
  // fixtures: one instanced mesh of moving-head lamps hanging from the truss
  const fixtures = [];
  for (let x = tr.x0 + 1.5; x <= tr.x1 - 1.4; x += 2.2) fixtures.push(new THREE.Matrix4().makeTranslation(x, tr.y - 0.45, tr.z + 0.2));
  const headGeo = mergeGeometries([new THREE.CylinderGeometry(0.22, 0.28, 0.5, 10).rotateX(Math.PI / 2.6), box(0.5, 0.08, 0.3, 0, 0.3, 0)]);
  const heads = new THREE.InstancedMesh(headGeo, toon(0x1d1b22), fixtures.length);
  fixtures.forEach((m, i) => heads.setMatrixAt(i, m));
  heads.name = "truss-fixtures";
  root.add(heads);

  // A few soft light shafts from the truss onto the deck (additive, no real lights, no shadows).
  const beamTex = canvasTex(64, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "rgba(255,255,255,.55)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  const beamGeo = new THREE.CylinderGeometry(0.25, 2.1, 1, 16, 1, true).translate(0, -0.5, 0);
  const beams = [];
  const beamMat = (c) => new THREE.MeshBasicMaterial({ map: beamTex, color: c, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const cols = [0xbfc8ff, 0xffffff, 0x9aa6ff];
  [-9, -3, 3, 9].forEach((dx, i) => {
    const m = new THREE.Mesh(beamGeo, beamMat(cols[i % 3]));
    const len = tr.y - S.h - 0.3;
    m.scale.set(1, len, 1);
    m.position.set(sc.x + dx, tr.y - 0.6, tr.z + 0.2);
    m.rotation.x = -0.32; // lean back toward the stage
    m.rotation.z = dx * 0.012;
    m.name = "light-beam";
    root.add(m);
    beams.push(m);
  });

  // Podiums with an indigo front panel.
  for (const p of S.podiums) {
    add(mergeGeometries([box(0.9, 1.15, 0.7, p.x, S.h + 0.575, p.z), box(1.0, 0.08, 0.8, p.x, S.h + 1.19, p.z - 0.04)]), toon(0x2a2733), { name: "podium" });
    add(box(0.7, 0.7, 0.02, p.x, S.h + 0.65, p.z + 0.36), toon(0x3d4bb8, 0x3d4bb8, 0.5), { shadow: false, name: "podium-panel" });
  }

  // Floral signage panels either side of the stage.
  const flTex = canvasTex(512, 1024, (g, w, h) => floral(g, w, h, "MAIN STAGE"));
  for (const [i, w] of S.wings.entries()) {
    const g = new THREE.Group();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 6.4), new THREE.MeshBasicMaterial({ map: flTex }));
    face.position.set(0, 3.4, 0.21);
    const back = new THREE.Mesh(new THREE.BoxGeometry(3.4, 6.8, 0.4).translate(0, 3.4, 0), toon(0x2b2230));
    back.castShadow = true;
    g.add(back, face);
    g.position.set(w.x, 0, w.z);
    g.rotation.y = i ? -0.28 : 0.28; // angled toward the audience
    g.name = "floral-panel";
    root.add(g);
  }

  // Audience chairs: one instanced mesh (seat, back and legs merged), facing the stage.
  const chairGeo = mergeGeometries([
    box(0.5, 0.08, 0.48, 0, 0.46, 0), // seat
    box(0.5, 0.52, 0.07, 0, 0.75, 0.22), // back (south side, so the chair faces north)
    box(0.05, 0.46, 0.05, -0.21, 0.23, -0.19), box(0.05, 0.46, 0.05, 0.21, 0.23, -0.19),
    box(0.05, 0.46, 0.05, -0.21, 0.23, 0.2), box(0.05, 0.46, 0.05, 0.21, 0.23, 0.2),
  ]);
  const seats = L.seatPositions();
  const chairs = new THREE.InstancedMesh(chairGeo, toon(0xc9a24a), seats.length);
  seats.forEach((s, i) => chairs.setMatrixAt(i, new THREE.Matrix4().makeTranslation(s.x, 0, s.z)));
  chairs.castShadow = false; // hundreds of small shadows cost more than they add
  chairs.receiveShadow = true;
  chairs.name = "audience-chairs";
  root.add(chairs);

  // A soft key light on the deck (one spot, no shadows) so presenters read against the LED wall.
  const key = new THREE.SpotLight(0xfff2dd, 60, 30, 0.6, 0.7, 1.2);
  key.position.set(sc.x, tr.y, tr.z + 2);
  key.target.position.set(sc.x, S.h, S.z0 + 3);
  root.add(key, key.target);

  return { root, screens, beams, chairs, seats: seats.length };
}
