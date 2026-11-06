// The exhibitor corridor in Pavilion 2: thirteen stations against the north wall and its corners.
// Sponsor booths use the shell-scheme look of the hall (dark partitions, aluminium frame, a branded
// back wall and counter); Food & Drinks and the Washroom are venue facilities; the Mentor Station is
// a consultation area. All solid parts share ONE vertex-coloured toon material and are merged into a
// single mesh; signage is one canvas texture per surface.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { grad } from "../assets.js";
import * as L from "./layout.js";
import { canvasTex } from "./venue.js";
import { floral } from "./stage.js";

const INK = "#2b2230";
const PAPER = "#fbf3e4";

/**
 * How each booth looks. Taglines come only from what the event photos show (EF, ENS, Arkiv);
 * other names are shown plainly, with no invented logos or slogans.
 */
export const BRANDS = {
  "node-rails": { bg: "#20303f", fg: "#e8eef5", accent: "#5bb0d6" },
  gtmaxxing: { bg: "#3a1f3f", fg: "#fbe9ff", accent: "#e070c8" },
  namera: { bg: "#1f3a2c", fg: "#e9f7ee", accent: "#5ec98a" },
  "t-rex": { bg: "#3d2a17", fg: "#fff1de", accent: "#f0a040" },
  ns: { bg: "#f2f0ea", fg: "#1c1c1c", accent: "#1c1c1c" },
  definative: { bg: "#2b2a4a", fg: "#eceaff", accent: "#9b95ff" },
  chainlink: { bg: "#1b3a8c", fg: "#ffffff", accent: "#7aa2ff" },
  ef: { bg: "#17141d", fg: "#ece8f4", accent: "#9c8ae0", tagline: ["private reads", "private writes", "same ethereum"] },
  ens: { bg: "#f4f6fb", fg: "#1e2a44", accent: "#4b7fe8", tagline: ["ens.domains", "the naming layer"] },
  arkiv: { bg: "#2a2f8a", fg: "#ffffff", accent: "#f08a3c", tagline: ["[ ARKIV ]", "THE WEB3 DATABASE", "owned · queryable · time-scoped"] },
};

// ---------------------------------------------------------------- the painted surfaces
function poster(g, w, h, st, b) {
  g.fillStyle = b.bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = b.accent;
  g.fillRect(0, h - 26, w, 26);
  // a quiet geometric field, so booths differ without inventing logos
  g.globalAlpha = 0.16;
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    g.arc((i * w) / 8, h * 0.82, 60 + (i % 3) * 30, 0, Math.PI * 2);
    g.strokeStyle = b.accent;
    g.lineWidth = 10;
    g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = b.fg;
  g.textAlign = "center";
  const lines = b.tagline || [st.name];
  if (b.tagline) {
    g.font = `800 ${Math.round(h * 0.12)}px 'Bricolage Grotesque', system-ui, sans-serif`;
    g.fillText(st.name, w / 2, h * 0.2, w * 0.9);
    g.font = `${Math.round(h * 0.085)}px 'Patrick Hand', cursive`;
    lines.forEach((l, i) => g.fillText(l, w / 2, h * 0.38 + i * h * 0.11, w * 0.86));
  } else {
    g.font = `800 ${Math.round(h * 0.17)}px 'Bricolage Grotesque', system-ui, sans-serif`;
    g.fillText(st.name, w / 2, h * 0.42, w * 0.88);
    g.font = `${Math.round(h * 0.07)}px 'Patrick Hand', cursive`;
    g.fillText("exhibitor · press E at the counter", w / 2, h * 0.58, w * 0.86);
  }
}
function counterFront(g, w, h, st, b) {
  g.fillStyle = b.bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = b.fg;
  g.textAlign = "center";
  g.font = `800 ${Math.round(h * 0.42)}px 'Bricolage Grotesque', system-ui, sans-serif`;
  g.fillText(st.name, w / 2, h * 0.64, w * 0.9);
}
function fascia(g, w, h, text, bg, fg) {
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.textAlign = "center";
  g.font = `800 ${Math.round(h * 0.56)}px 'Bricolage Grotesque', system-ui, sans-serif`;
  g.fillText(text, w / 2, h * 0.72, w * 0.92);
}
function foodMenu(g, w, h) {
  g.fillStyle = "#2f4a3a";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#e9d9a8";
  g.lineWidth = 8;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.fillStyle = "#f6ecd2";
  g.textAlign = "center";
  g.font = `800 ${Math.round(h * 0.2)}px 'Bricolage Grotesque', system-ui, sans-serif`;
  g.fillText("FOOD & DRINKS", w / 2, h * 0.27, w * 0.9);
  g.font = `${Math.round(h * 0.12)}px 'Patrick Hand', cursive`;
  ["masala chai · filter coffee", "sandwiches · fruit · snacks", "water refills · free for participants"].forEach((l, i) => g.fillText(l, w / 2, h * 0.5 + i * h * 0.16, w * 0.86));
}
function washroomSign(g, w, h) {
  g.fillStyle = "#e9eef2";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#24507a";
  g.fillRect(0, 0, w, h * 0.3);
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.font = `800 ${Math.round(h * 0.2)}px 'Bricolage Grotesque', system-ui, sans-serif`;
  g.fillText("WASHROOMS", w / 2, h * 0.22, w * 0.9);
  // pictograms: standard figures, drawn simply
  const fig = (x, dress) => {
    g.fillStyle = "#24507a";
    g.beginPath();
    g.arc(x, h * 0.42, h * 0.06, 0, Math.PI * 2);
    g.fill();
    if (dress) {
      g.beginPath();
      g.moveTo(x, h * 0.5);
      g.lineTo(x - h * 0.1, h * 0.76);
      g.lineTo(x + h * 0.1, h * 0.76);
      g.closePath();
      g.fill();
    } else g.fillRect(x - h * 0.07, h * 0.5, h * 0.14, h * 0.26);
    g.fillRect(x - h * 0.05, h * 0.74, h * 0.035, h * 0.14);
    g.fillRect(x + h * 0.015, h * 0.74, h * 0.035, h * 0.14);
  };
  fig(w * 0.22, false);
  fig(w * 0.5, true);
  // accessible symbol: wheel + seated figure
  g.strokeStyle = "#24507a";
  g.lineWidth = h * 0.03;
  g.beginPath();
  g.arc(w * 0.78, h * 0.7, h * 0.11, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "#24507a";
  g.beginPath();
  g.arc(w * 0.79, h * 0.42, h * 0.05, 0, Math.PI * 2);
  g.fill();
  g.fillRect(w * 0.775, h * 0.48, h * 0.04, h * 0.18);
}

// ---------------------------------------------------------------- geometry helpers
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
const sph = (r, x, y, z) => new THREE.SphereGeometry(r, 10, 8).translate(x, y, z);

/** Build every station. Returns { root, stations: [{...station, group, center}] }. */
export function buildStations(scene) {
  const root = new THREE.Group();
  root.name = "exhibitor-corridor";
  scene.add(root);
  const solid = []; // world-space coloured geometry → one mesh
  const out = [];

  for (const st of L.STATIONS) {
    const m = new THREE.Matrix4().makeRotationY(st.yaw).setPosition(st.x, 0, st.z);
    const parts = [];
    const part = (geo, hex) => parts.push(colored(geo, hex));
    const signs = new THREE.Group(); // textured planes, in the station's local space
    const plane = (w, h, tex, x, y, z, ry = 0) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
      p.position.set(x, y, z);
      p.rotation.y = ry;
      signs.add(p);
      return p;
    };
    const { w, d } = st;
    // shell scheme: dark side partitions with an aluminium top rail (all station kinds)
    for (const sx of [-w / 2 + 0.06, w / 2 - 0.06]) {
      part(bx(0.12, 3.0, d - 0.2, sx, 1.5, (d - 0.2) / 2), "#232029");
      part(bx(0.16, 0.08, d - 0.2, sx, 3.04, (d - 0.2) / 2), "#c9cbd0");
    }
    part(bx(w, 0.1, 0.16, 0, 4.42, 0.12), "#c9cbd0");

    if (st.kind === "sponsor") {
      const b = BRANDS[st.key];
      part(bx(w - 0.1, 4.4, 0.2, 0, 2.2, 0.1), b.bg);
      plane(w - 0.4, 3.9, canvasTex(1024, Math.round((1024 * 3.9) / (w - 0.4)), (g, cw, ch) => poster(g, cw, ch, st, b)), 0, 2.35, 0.215);
      // counter with a branded front, a laptop, two stools; a plant; queue posts with a belt
      const cw = Math.min(2.6, w * 0.6);
      const cz = d - 0.75;
      part(bx(cw, 1.0, 0.6, 0, 0.5, cz), "#1f1c25");
      part(bx(cw + 0.1, 0.06, 0.7, 0, 1.03, cz), "#e9e5dc");
      plane(cw - 0.1, 0.8, canvasTex(512, Math.round((512 * 0.8) / (cw - 0.1)), (g, a, c) => counterFront(g, a, c, st, b)), 0, 0.5, cz + 0.305);
      part(bx(0.5, 0.03, 0.35, -cw * 0.25, 1.075, cz - 0.05), "#b9bcc3");
      part(bx(0.5, 0.32, 0.02, -cw * 0.25, 1.24, cz - 0.21), "#2a2d34");
      for (const sx of [-0.55, 0.55]) part(cyl(0.2, 0.2, 0.06, sx, 0.72, cz - 0.75), "#3a3640"), part(cyl(0.04, 0.04, 0.7, sx, 0.35, cz - 0.75, 6), "#9a9ca4");
      part(cyl(0.22, 0.17, 0.42, w / 2 - 0.55, 0.21, 0.55), "#c9b79a");
      part(sph(0.4, w / 2 - 0.55, 0.75, 0.55), "#4f8a52");
      for (const sx of [-w / 2 + 0.45, w / 2 - 0.45]) part(cyl(0.035, 0.035, 0.95, sx, 0.47, d - 0.05, 8), "#c9cbd0"), part(cyl(0.16, 0.16, 0.03, sx, 0.015, d - 0.05), "#c9cbd0");
      part(bx(w - 0.9, 0.06, 0.02, 0, 0.88, d - 0.05), "#1f1c25");
      plane(w - 0.3, 0.55, canvasTex(1024, Math.round((1024 * 0.55) / (w - 0.3)), (g, a, c) => fascia(g, a, c, st.name, "#1f1c25", "#ffffff")), 0, 4.75, 0.2);
    } else if (st.kind === "food") {
      // a facility: tiled back wall, menu board, a long buffet counter with urns, trays and cups
      part(bx(w - 0.1, 4.4, 0.2, 0, 2.2, 0.1), "#efe6d2");
      part(bx(w - 0.1, 0.5, 0.21, 0, 1.25, 0.1), "#2f6f62");
      plane(w * 0.7, 1.7, canvasTex(1024, Math.round((1024 * 1.7) / (w * 0.7)), foodMenu), 0, 3.0, 0.215);
      const cz = 1.2;
      part(bx(w - 0.8, 0.95, 0.8, 0, 0.475, cz), "#5a3b28");
      part(bx(w - 0.7, 0.06, 0.9, 0, 0.98, cz), "#e9e5dc");
      for (const x of [-1.9, -0.6]) part(cyl(0.38, 0.38, 0.18, x, 1.1, cz, 16), "#c9cbd0"), part(sph(0.36, x, 1.2, cz).scale(1, 0.45, 1).translate(0, 0.66, 0), "#dfe1e6");
      for (const x of [0.7, 1.25]) part(cyl(0.17, 0.17, 0.55, x, 1.29, cz - 0.1, 14), "#b8bcc4"), part(cyl(0.05, 0.05, 0.08, x, 1.6, cz - 0.1, 8), "#2b2230");
      for (let i = 0; i < 6; i++) part(cyl(0.05, 0.04, 0.11, 1.85 + (i % 3) * 0.13, 1.065 + Math.floor(i / 3) * 0.11, cz + 0.15, 8), "#fbf3e4");
      for (let i = 0; i < 5; i++) part(cyl(0.035, 0.035, 0.24, 2.2 + (i - 2) * 0.09, 1.13, cz - 0.25, 8), "#7fc4e0");
      for (const x of [-1.6, 1.6]) part(cyl(0.32, 0.32, 0.04, x, 1.08, d - 0.55, 18), "#e9e5dc"), part(cyl(0.05, 0.05, 1.06, x, 0.53, d - 0.55, 8), "#3a3640"), part(cyl(0.22, 0.22, 0.03, x, 0.015, d - 0.55, 14), "#3a3640");
      plane(w - 0.3, 0.55, canvasTex(1024, Math.round((1024 * 0.55) / (w - 0.3)), (g, a, c) => fascia(g, a, c, "Food & Drinks", "#2f6f62", "#ffffff")), 0, 4.75, 0.2);
    } else if (st.kind === "washroom") {
      // a facility: grey tiled wall, two recessed doorways with frames, signage, a wet-floor sign
      part(bx(w - 0.1, 4.4, 0.2, 0, 2.2, 0.1), "#d7dde2");
      for (const x of [-1.45, 1.45]) {
        part(bx(1.3, 2.4, 0.05, x, 1.2, 0.22), "#3f4650");
        part(bx(1.5, 0.12, 0.14, x, 2.46, 0.25), "#9aa3ad");
        part(bx(0.1, 2.4, 0.14, x - 0.7, 1.2, 0.25), "#9aa3ad");
        part(bx(0.1, 2.4, 0.14, x + 0.7, 1.2, 0.25), "#9aa3ad");
      }
      plane(2.6, 1.1, canvasTex(768, 325, washroomSign), 0, 3.35, 0.215);
      part(bx(0.5, 0.7, 0.04, 0.0, 0.35, 1.6).rotateZ(0), "#f5c84c");
      part(bx(0.04, 0.72, 0.4, 0.0, 0.35, 1.6), "#f5c84c");
      plane(w - 0.3, 0.55, canvasTex(1024, Math.round((1024 * 0.55) / (w - 0.3)), (g, a, c) => fascia(g, a, c, "Washrooms", "#24507a", "#ffffff")), 0, 4.75, 0.2);
    } else if (st.kind === "mentor") {
      // a welcoming consultation area: floral backdrop, a long mentor table, chairs on both sides, a plant
      part(bx(w - 0.1, 4.4, 0.2, 0, 2.2, 0.1), "#5a2a2e");
      plane(2.6, 4.0, canvasTex(512, 788, (g, a, c) => floral(g, a, c, "MENTOR STATION")), -w / 2 + 1.6, 2.2, 0.215);
      const tz = 2.0;
      part(bx(3.2, 0.06, 1.0, 0.7, 0.76, tz), "#3a1f24");
      part(bx(3.2, 0.7, 0.04, 0.7, 0.4, tz + 0.5), "#4a2830");
      part(bx(3.2, 0.7, 0.04, 0.7, 0.4, tz - 0.5), "#4a2830");
      for (const x of [-0.3, 0.7, 1.7]) {
        for (const side of [-1, 1]) {
          const z = tz + side * 0.95;
          part(bx(0.46, 0.06, 0.44, x, 0.47, z), "#c9a24a");
          part(bx(0.46, 0.5, 0.06, x, 0.74, z + side * 0.22), "#c9a24a");
          for (const lx of [-0.18, 0.18]) for (const lz of [-0.17, 0.17]) part(bx(0.04, 0.45, 0.04, x + lx, 0.22, z + lz), "#8a6d2c");
        }
      }
      part(bx(0.5, 0.03, 0.35, 0.2, 0.805, tz), "#b9bcc3");
      part(cyl(0.26, 0.2, 0.5, w / 2 - 0.5, 0.25, 0.5), "#c9b79a");
      part(sph(0.5, w / 2 - 0.5, 0.95, 0.5), "#4f8a52");
      plane(w - 0.3, 0.55, canvasTex(1024, Math.round((1024 * 0.55) / (w - 0.3)), (g, a, c) => fascia(g, a, c, "Mentor Station · ask for help", "#7d2f2f", "#fbe7b0")), 0, 4.75, 0.2);
    }

    for (const p of parts) solid.push(p.applyMatrix4(m));
    signs.applyMatrix4(m);
    root.add(signs);
    const front = L.stationFront(st);
    out.push({ ...st, signs, front, center: new THREE.Vector3(st.x + Math.sin(st.yaw) * st.d * 0.5, 2.2, st.z + Math.cos(st.yaw) * st.d * 0.5) });
  }
  const mesh = new THREE.Mesh(mergeGeometries(solid), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: grad }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "stations-solid";
  root.add(mesh);
  return { root, stations: out };
}
