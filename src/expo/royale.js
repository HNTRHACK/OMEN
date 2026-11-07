// Bounty Royale in the Mumbai venue: directional signage from the arrival concourse, the arena
// itself (the festival pavilion inside Pavilion 2), and a live scoreboard hung over its counter.
// The scoreboard shows only what the server says (/api/royale/state, refreshed on Socket.IO).
import * as THREE from "three";
import { io } from "socket.io-client";
import * as L from "./layout.js";

const INK = "#2B2230";
const PAPER = "#FBF3E4";
const BUTTER = "#F3D98B";

function canvasPlane(w, h, px = 256) {
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(w * px), height: Math.round(h * px) });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  return { c, g: c.getContext("2d"), tex, mesh };
}

function sign(lines, w, h, { bg = INK, fg = BUTTER, sub = PAPER } = {}) {
  const s = canvasPlane(w, h, 200);
  const { g, c } = s;
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = BUTTER;
  g.lineWidth = c.height * 0.05;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, c.width - g.lineWidth, c.height - g.lineWidth);
  g.textAlign = "center";
  g.textBaseline = "middle";
  lines.forEach((ln, i) => {
    const size = i === 0 ? c.height * 0.3 : c.height * 0.17;
    g.font = `800 ${size}px 'Bricolage Grotesque', system-ui, sans-serif`;
    g.fillStyle = i === 0 ? fg : sub;
    g.fillText(ln, c.width / 2, c.height * (lines.length === 1 ? 0.5 : 0.3 + (i * 0.55) / Math.max(1, lines.length - 1)), c.width * 0.92);
  });
  s.tex.needsUpdate = true;
  return s.mesh;
}

/** A free-standing signpost (post + board), base at (x, z), board facing +Z rotated by `yaw`. */
function standee(lines, x, z, yaw = 0) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.2, 8), new THREE.MeshLambertMaterial({ color: 0x2b2230 }));
  post.position.y = 1.1;
  g.add(post);
  const board = sign(lines, 2.6, 1.3);
  board.position.set(0, 2.55, 0.08);
  const back = board.clone();
  back.rotation.y = Math.PI;
  back.position.z = -0.08;
  g.add(board, back);
  g.position.set(x, L.groundAt(x, z), z);
  g.rotation.y = yaw;
  return g;
}

export function buildRoyale(scene) {
  const group = new THREE.Group();
  group.name = "bounty-royale";
  const P2 = L.PAVILIONS[1];
  // concourse: two signposts flanking the walk from the arrival point to Pavilion 2's portal
  group.add(standee(["BOUNTY ROYALE ↑", "PAVILION 2 · STRAIGHT AHEAD"], L.SPAWN.x - 4.2, 7.5));
  group.add(standee(["BOUNTY ROYALE ↑", "PREDICTION ARENA · PAVILION 2"], L.SPAWN.x + 4.2, 7.5));
  // over Pavilion 2's portal, both faces
  const banner = sign(["PAVILION 2 · BOUNTY ROYALE", "THE PREDICTION ARENA IS INSIDE · FREE POINTS ONLY"], 12, 1.6);
  banner.position.set(P2.cx, L.PORTAL_H + 0.5, 0.35);
  const bannerIn = banner.clone();
  bannerIn.rotation.y = Math.PI;
  bannerIn.position.z = -0.35;
  group.add(banner, bannerIn);
  // inside Pavilion 2: point from the portal to the arena
  group.add(standee(["BOUNTY ROYALE ↓", "ARENA UNDER THE ORANGE CANOPY"], L.TENT.x + 5.5, -8, Math.PI));
  // the arena's live scoreboard, above the back counter, facing the way in
  const board = canvasPlane(6.4, 2.6, 160);
  board.mesh.position.set(L.TENT.x, 4.3, L.TENT.counters[0].z - 0.9);
  group.add(board.mesh);
  // a floor ring marking the interaction zone
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.4, 48), new THREE.MeshBasicMaterial({ color: 0xf3d98b, transparent: true, opacity: 0.85 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(L.TENT.x, L.groundAt(L.TENT.x, L.TENT.z) + 0.03, L.TENT.z + 1.5);
  group.add(ring);
  scene.add(group);

  let state = null;
  let online = 0;
  function paint() {
    const { g, c } = board;
    const W = c.width;
    const H = c.height;
    g.fillStyle = "#121018";
    g.fillRect(0, 0, W, H);
    g.strokeStyle = BUTTER;
    g.lineWidth = 10;
    g.strokeRect(5, 5, W - 10, H - 10);
    g.textBaseline = "middle";
    g.textAlign = "left";
    g.fillStyle = BUTTER;
    g.font = `800 ${H * 0.13}px 'Bricolage Grotesque', system-ui, sans-serif`;
    g.fillText("BOUNTY ROYALE · LIVE", W * 0.04, H * 0.13);
    g.textAlign = "right";
    g.fillStyle = PAPER;
    g.font = `700 ${H * 0.075}px system-ui, sans-serif`;
    const pool = state ? state.markets.reduce((a, m) => a + (m.status === "settled" || m.status === "void" ? 0 : m.pool), 0) : 0;
    g.fillText(`${online} watching · ${pool.toLocaleString("en-IN")} pts in open pools`, W * 0.96, H * 0.13);
    g.textAlign = "left";
    const rows = state?.leaderboard.slice(0, 5) || [];
    g.font = `700 ${H * 0.095}px system-ui, sans-serif`;
    if (!rows.length) {
      g.fillStyle = PAPER;
      g.fillText(state ? "No predictions yet. Be the first: press E." : "Connecting to the arena…", W * 0.04, H * 0.5);
    }
    rows.forEach((r, i) => {
      const y = H * (0.32 + i * 0.13);
      g.fillStyle = i === 0 ? BUTTER : PAPER;
      g.fillText(`#${r.rank}  ${r.name}`, W * 0.04, y, W * 0.6);
      g.textAlign = "right";
      g.fillText(`${r.score.toLocaleString("en-IN")} pts`, W * 0.96, y);
      g.textAlign = "left";
    });
    g.fillStyle = "#c9bfae";
    g.font = `700 ${H * 0.06}px system-ui, sans-serif`;
    g.fillText("Free OMEN points only · non-transferable · non-redeemable", W * 0.04, H * 0.93);
    board.tex.needsUpdate = true;
  }
  paint();

  let t = 0;
  const load = async () => {
    try {
      state = await fetch("/api/royale/state", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null));
    } catch {
      /* keep the last good board */
    }
    paint();
  };
  const refresh = () => (clearTimeout(t), (t = setTimeout(load, 300)));
  const sock = io("/royale", { path: "/royale-io/", transports: ["websocket"] });
  sock.on("connect", refresh);
  sock.on("royale:changed", refresh);
  sock.on("royale:reveal", refresh);
  sock.on("royale:presence", (p) => ((online = sock.online = p.online), paint()));
  load();

  /** Inside Pavilion 2's arena (the canopy footprint, or its open front). */
  const inArena = (x, z) => L.inTent(x, z) || (Math.abs(x - L.TENT.x) < L.TENT.w / 2 && z > L.TENT.z + L.TENT.d / 2 && z < L.TENT.z + L.TENT.d / 2 + 2.5);
  return { group, board, inArena, refresh, socket: sock, get state() { return state; } };
}
