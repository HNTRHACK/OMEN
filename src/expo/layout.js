// The OMEN venue floor plan: a stylised digital interpretation of the exhibition halls of the Jio
// World Convention Centre, Mumbai (public factsheet: three pavilions of 63, 90 and 68 m by 68 m,
// 12 m ceilings, branching "tree" columns, a daylit triple-height concourse with LED screens),
// with the look of the halls as photographed during ETHGlobal Mumbai. It is NOT an official venue
// or event floor plan: zone placement is OMEN's own.
//
// Units are metres at 0.75 scale. x runs east, z runs south, y is up. Halls are north of z = 0,
// the arrival concourse south of it. Pure data + helpers (no three.js) so it can be unit-tested.

export const SCALE = 0.75;
export const HALL_H = 12; // ceiling height (factsheet)
export const CONCOURSE_H = 16; // triple-height arrival concourse
export const HALL_D = 51; // 68 m × 0.75
export const CONCOURSE_D = 22;
export const WALL_T = 0.6;

// Pavilion widths from the factsheet (63, 90, 68 m) × 0.75, west → east. `phase` is when OMEN
// builds each zone; only Phase 1 (arrival hall + Main Stage) exists in this milestone.
export const PAVILIONS = [
  { id: 1, key: "stage", name: "Pavilion 1", theme: "Main Stage", blurb: "Keynotes and finalist demos on a big LED wall. Walk up the side steps onto the stage.", x0: -84, x1: -36.75, color: 0xc8473d, open: true },
  { id: 2, key: "expo", name: "Pavilion 2", theme: "Advertising & Sponsor Expo", blurb: "The exhibitor corridor: 13 stations around the north wall, from Node Rails to Arkiv. Player ad inventory on booth screens comes next.", x0: -36.75, x1: 30.75, color: 0x3e8e8a, open: true },
  { id: 3, key: "community", name: "Pavilion 3", theme: "Judging, Lounge & Market", blurb: "Finalist judging, the community lounge with Alfred, refreshments and the marketplace. Coming later.", x0: 30.75, x1: 81.75, color: 0x7d5a8c, open: false },
].map((p) => ({ ...p, cx: (p.x0 + p.x1) / 2, w: p.x1 - p.x0 }));

export const BOUNDS = { x0: PAVILIONS[0].x0, x1: PAVILIONS[2].x1, z0: -HALL_D, z1: CONCOURSE_D };

/** Wide portals from the concourse into each pavilion. */
export const PORTAL_W = 18;
export const PORTAL_H = 8;
export const portals = PAVILIONS.map((p) => ({ pavilion: p.id, x0: p.cx - PORTAL_W / 2, x1: p.cx + PORTAL_W / 2 }));

/** Operable walls between pavilions, each with a 24 m opening for cross-traffic. */
export const DIVIDER_GAP = { z0: -38, z1: -14 };
export const dividers = [PAVILIONS[0].x1, PAVILIONS[1].x1];

/** Tree columns, roughly on a 20 m grid, kept clear of portals, the stage and the seating. */
export const COLUMNS = [
  [-79, -12], [-41.5, -12], [-79, -32], [-41.5, -32],
  [-24, -14], [18, -14], [-3, -27], [-24, -40], [18, -40],
  [44, -14], [68, -14], [44, -38], [68, -38],
].map(([x, z]) => ({ x, z, r: 0.55 }));

// ---------------------------------------------------------------- the Main Stage (Pavilion 1)
const SX = PAVILIONS[0].cx; // the stage is centred on the pavilion
export const STAGE = {
  x0: SX - 11.6, x1: SX + 11.6, z0: -50.4, z1: -41.6, h: 1.1,
  // side steps on the west end, rising eastward onto the stage
  steps: { x0: SX - 14.4, x1: SX - 11.6, z0: -47.2, z1: -43.6 },
  screen: { x: SX, z: -50.55, w: 19, h: 8.6, y0: 2.0 }, // the giant LED wall
  wings: [{ x: SX - 14.6, z: -48.4 }, { x: SX + 14.6, z: -48.4 }], // floral signage panels
  podiums: [{ x: SX - 6.5, z: -44.2 }, { x: SX + 6.5, z: -44.2 }],
  truss: { x0: SX - 14, x1: SX + 14, z: -40.4, y: 10.2 },
};
/** Audience seating: two blocks either side of a 3 m centre aisle, facing the stage. */
export const SEAT = { pitchX: 0.62, pitchZ: 1.15, z0: -37.5, rows: 14, aisle: 3, blockW: 9.6 };
export const SEAT_BLOCKS = [
  { x0: SX - SEAT.aisle / 2 - SEAT.blockW, x1: SX - SEAT.aisle / 2 },
  { x0: SX + SEAT.aisle / 2, x1: SX + SEAT.aisle / 2 + SEAT.blockW },
].map((b) => ({ ...b, z0: SEAT.z0, z1: SEAT.z0 + (SEAT.rows - 1) * SEAT.pitchZ + 0.5 }));

/** Seat positions (x, z) for instancing: every chair faces north, toward the stage. */
export function seatPositions() {
  const out = [];
  for (const b of SEAT_BLOCKS)
    for (let r = 0; r < SEAT.rows; r++)
      for (let x = b.x0 + 0.31; x <= b.x1 - 0.3; x += SEAT.pitchX) out.push({ x, z: SEAT.z0 + r * SEAT.pitchZ });
  return out;
}

/** Floor height under (x, z): the stage deck, its steps, else the hall floor. */
export function groundAt(x, z) {
  const s = STAGE;
  if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) return s.h;
  const t = s.steps;
  if (x >= t.x0 && x <= t.x1 && z >= t.z0 && z <= t.z1) return (s.h * (x - t.x0)) / (t.x1 - t.x0);
  return 0;
}
/** The highest step a walker climbs without jumping. */
export const STEP_UP = 0.45;

// ---------------------------------------------------------------- the exhibitor corridor (Pavilion 2)
// Built against Pavilion 2's long north wall (the one with the blue mandala band), continuing round
// both corners onto the operable walls so nothing is crammed: a U, walked in this order. Every
// station's front (local +Z) faces into the hall; a 7 m corridor runs in front of them all, clear of
// the tree columns. Station names are as listed by the OMEN team; the layout is OMEN's own.
export const STATION_ORDER = ["node-rails", "gtmaxxing", "food", "namera", "t-rex", "washroom", "ns", "definative", "chainlink", "mentor", "ef", "ens", "arkiv"];
const P2 = { x0: -36.75 + WALL_T / 2, x1: 30.75 - WALL_T / 2, zN: -HALL_D + WALL_T / 2 };
const NORTH_RUN = { x0: P2.x0 + 3.4, x1: P2.x1 - 3.4 }; // leave the corners to the side runs
const NAMES = {
  "node-rails": ["Node Rails", "sponsor"], gtmaxxing: ["GTMaxxing", "sponsor"], food: ["Food & Drinks", "food"], namera: ["Namera", "sponsor"],
  "t-rex": ["T-REX", "sponsor"], washroom: ["Washroom", "washroom"], ns: ["ns.com", "sponsor"], definative: ["Definative", "sponsor"],
  chainlink: ["Chainlink", "sponsor"], mentor: ["Mentor Station", "mentor"], ef: ["Ethereum Foundation", "sponsor"], ens: ["ENS.domain", "sponsor"], arkiv: ["Arkiv", "sponsor"],
};
export const STATIONS = (() => {
  const out = [];
  const side = (key, x, z, yaw) => out.push({ key, name: NAMES[key][0], kind: NAMES[key][1], x, z, yaw, w: 4.2, d: 3.0, wall: yaw > 0 ? "west" : "east" });
  side("node-rails", P2.x0, -40.9, Math.PI / 2); // west operable wall, facing east
  side("gtmaxxing", P2.x0, -45.3, Math.PI / 2);
  const north = STATION_ORDER.slice(2, 11);
  const pitch = (NORTH_RUN.x1 - NORTH_RUN.x0) / north.length;
  north.forEach((key, i) => {
    const kind = NAMES[key][1];
    out.push({ key, name: NAMES[key][0], kind, x: NORTH_RUN.x0 + pitch * (i + 0.5), z: P2.zN, yaw: 0, w: pitch - 0.6, d: kind === "mentor" ? 4.0 : 3.2, wall: "north" });
  });
  side("ens", P2.x1, -45.3, -Math.PI / 2); // east operable wall, facing west
  side("arkiv", P2.x1, -40.9, -Math.PI / 2);
  return out;
})();
/** A station's footprint as a world box, and the spot to stand at to interact. */
export function stationBox(st) {
  const hw = st.w / 2;
  if (st.yaw === 0) return { x0: st.x - hw, x1: st.x + hw, z0: st.z, z1: st.z + st.d, kind: "station" };
  return st.yaw > 0 ? { x0: st.x, x1: st.x + st.d, z0: st.z - hw, z1: st.z + hw, kind: "station" } : { x0: st.x - st.d, x1: st.x, z0: st.z - hw, z1: st.z + hw, kind: "station" };
}
export const stationFront = (st, gap = 1.3) => ({ x: st.x + Math.sin(st.yaw) * (st.d + gap), z: st.z + Math.cos(st.yaw) * (st.d + gap) });

export const SPAWN = { x: -3, z: 13, yaw: Math.PI }; // arrival, facing north (yaw: forward = (sin, cos))
export const VILLAGE_DOOR = { x: 79.5, z: 11, label: "Back to Blockhaven village" };

/** Named places for quick travel and the map. */
export const PLACES = [
  { key: "concourse", label: "Arrival hall", x: SPAWN.x, z: SPAWN.z, yaw: Math.PI },
  ...PAVILIONS.map((p) => ({ key: `p${p.id}`, label: `${p.name} · ${p.theme}`, x: p.cx, z: -6, yaw: Math.PI })),
];

/** Axis-aligned wall boxes { x0, x1, z0, z1 }. */
export function wallBoxes() {
  const t = WALL_T / 2;
  const b = [];
  const { x0, x1, z0, z1 } = BOUNDS;
  b.push({ x0: x0 - t, x1: x1 + t, z0: z0 - t, z1: z0 + t, kind: "north" });
  b.push({ x0: x0 - t, x1: x1 + t, z0: z1 - t, z1: z1 + t, kind: "south" });
  b.push({ x0: x0 - t, x1: x0 + t, z0, z1, kind: "west" });
  b.push({ x0: x1 - t, x1: x1 + t, z0, z1, kind: "east" });
  let cur = x0;
  for (const p of portals) {
    b.push({ x0: cur, x1: p.x0, z0: -t, z1: t, kind: "front" });
    cur = p.x1;
  }
  b.push({ x0: cur, x1, z0: -t, z1: t, kind: "front" });
  for (const x of dividers) {
    b.push({ x0: x - t, x1: x + t, z0, z1: DIVIDER_GAP.z0, kind: "divider" });
    b.push({ x0: x - t, x1: x + t, z0: DIVIDER_GAP.z1, z1: -t, kind: "divider" });
  }
  return b;
}

/** Solid things on the floor (not walls): seating blocks, stage furniture, the LED wall. */
export function propBoxes() {
  const s = STAGE;
  const b = SEAT_BLOCKS.map((k) => ({ x0: k.x0, x1: k.x1, z0: k.z0 - 0.3, z1: k.z1, kind: "seats" }));
  b.push({ x0: s.screen.x - s.screen.w / 2 - 0.3, x1: s.screen.x + s.screen.w / 2 + 0.3, z0: -51, z1: s.screen.z + 0.45, kind: "screen" });
  for (const w of s.wings) b.push({ x0: w.x - 1.7, x1: w.x + 1.7, z0: w.z - 0.35, z1: w.z + 0.35, kind: "wing" });
  for (const p of s.podiums) b.push({ x0: p.x - 0.45, x1: p.x + 0.45, z0: p.z - 0.35, z1: p.z + 0.35, kind: "podium" });
  for (const x of [s.truss.x0, s.truss.x1]) b.push({ x0: x - 0.4, x1: x + 0.4, z0: s.truss.z - 0.4, z1: s.truss.z + 0.4, kind: "truss" });
  b.push({ x0: SPAWN.x - 1.3, x1: SPAWN.x + 1.3, z0: 4.2, z1: 4.9, kind: "totem" });
  for (const st of STATIONS) b.push(stationBox(st));
  for (const dx of [-7.5, 7.5]) b.push({ x0: SPAWN.x + dx - 0.6, x1: SPAWN.x + dx + 0.6, z0: 15.3, z1: 17.7, kind: "arch" });
  return b;
}
export const solidBoxes = () => wallBoxes().concat(propBoxes());

/** Which pavilion (1–3) a point is in, 0 for the arrival concourse, -1 outside. */
export function zoneAt(x, z) {
  if (x < BOUNDS.x0 || x > BOUNDS.x1 || z < BOUNDS.z0 || z > BOUNDS.z1) return -1;
  if (z >= 0) return 0;
  return PAVILIONS.find((p) => x >= p.x0 && x < p.x1)?.id ?? -1;
}

/** Push a circle of radius r at (x, z) out of boxes and columns. */
export function collide(x, z, r, boxes = solidBoxes()) {
  for (let pass = 0; pass < 2; pass++) {
    for (const b of boxes) {
      const cx = Math.max(b.x0, Math.min(x, b.x1));
      const cz = Math.max(b.z0, Math.min(z, b.z1));
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * r;
        z = cz + (dz / d) * r;
      } else {
        const opts = [[b.x0 - r - x, 0], [b.x1 + r - x, 0], [0, b.z0 - r - z], [0, b.z1 + r - z]];
        const [mx, mz] = opts.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]))[0];
        x += mx;
        z += mz;
      }
    }
    for (const c of COLUMNS) {
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = c.r + r;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-9) {
        const d = Math.sqrt(d2);
        x = c.x + (dx / d) * rr;
        z = c.z + (dz / d) * rr;
      }
    }
  }
  return { x, z };
}

/**
 * Camera clipping: where the segment from the player's head (ax, az) to the wanted camera point
 * (bx, bz) first enters a wall or the LED wall. Returns t in [0, 1] (1 = unobstructed).
 */
export function clipSegment(ax, az, bx, bz, boxes, pad = 0.35) {
  let best = 1;
  const dx = bx - ax;
  const dz = bz - az;
  for (const b of boxes) {
    const x0 = b.x0 - pad, x1 = b.x1 + pad, z0 = b.z0 - pad, z1 = b.z1 + pad;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, d, lo, hi] of [[ax, dx, x0, x1], [az, dz, z0, z1]]) {
      if (Math.abs(d) < 1e-9) {
        if (p < lo || p > hi) ok = false;
      } else {
        let ta = (lo - p) / d;
        let tb = (hi - p) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
    }
    if (ok && t0 <= t1 && t0 > 0 && t0 < best) best = t0;
  }
  return best;
}

// Multiplayer: the server stores positions as a unit "up" direction (made for the planet). The
// flat hall maps onto that losslessly as a point on a very large virtual sphere.
export const RV = 1000;
export function encodePos(x, z) {
  const l = Math.hypot(x / RV, 1, z / RV);
  return [x / RV / l, 1 / l, z / RV / l];
}
export function decodePos(d) {
  return { x: (d[0] / d[1]) * RV, z: (d[2] / d[1]) * RV };
}
