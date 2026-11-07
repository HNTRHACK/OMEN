// The venue's floor plan (src/expo/layout.js): generous routes, nothing blocking the portals,
// a climbable stage, collisions that hold, and lossless multiplayer position encoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../src/expo/layout.js";

const inBox = (x, z, b, r = 0) => x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r;

test("proportions follow the factsheet at 0.75 scale: three pavilions, 12 m ceilings", () => {
  const widths = L.PAVILIONS.map((p) => p.w);
  assert.deepEqual(widths.map((w) => Math.round(w / L.SCALE)), [63, 90, 68]);
  assert.equal(L.HALL_D, 68 * L.SCALE);
  assert.equal(L.HALL_H, 12);
});

test("spawn and every quick-travel point are clear of walls, props and columns", () => {
  for (const p of L.PLACES) {
    assert.ok(!L.solidBoxes().some((b) => inBox(p.x, p.z, b, 0.5)), `${p.key} is inside something`);
    assert.ok(L.COLUMNS.every((c) => Math.hypot(p.x - c.x, p.z - c.z) > c.r + 1), `${p.key} is on a column`);
    assert.notEqual(L.zoneAt(p.x, p.z), -1);
  }
});

test("wide routes: 18 m portals with no column within 6 m of a portal's walking line", () => {
  for (const p of L.portals) {
    assert.ok(p.x1 - p.x0 >= 18);
    for (const c of L.COLUMNS) if (c.x > p.x0 && c.x < p.x1) assert.ok(c.z < -6, `column at ${c.x},${c.z} blocks a portal`);
  }
  assert.ok(L.DIVIDER_GAP.z1 - L.DIVIDER_GAP.z0 >= 24, "24 m openings between pavilions");
  assert.ok(L.SEAT.aisle >= 3, "a 3 m centre aisle through the audience");
});

test("the Main Stage: steps rise smoothly onto the deck; the deck front is too tall to walk up", () => {
  const s = L.STAGE;
  const zm = (s.steps.z0 + s.steps.z1) / 2;
  let prev = 0;
  for (let x = s.steps.x0 - 0.5; x <= s.x0 + 1; x += 0.1) {
    const h = L.groundAt(x, zm);
    assert.ok(h - prev <= L.STEP_UP, `step of ${h - prev} at x=${x}`);
    prev = h;
  }
  assert.equal(L.groundAt(s.x0 + 2, zm), s.h);
  assert.ok(s.h > L.STEP_UP, "the front edge blocks walkers");
  assert.ok(L.seatPositions().length > 300);
  for (const p of L.seatPositions()) assert.ok(p.z > s.z1 + 3, "front row at least 3 m from the stage");
});

test("collide() pushes a walker out of walls and columns", () => {
  const out = L.collide(-40, 0.1, 0.42); // inside the front wall between portals 1 and 2
  assert.ok(Math.abs(out.z) >= 0.3 + 0.42 - 1e-6);
  const c = L.COLUMNS[0];
  const p = L.collide(c.x + 0.2, c.z, 0.42);
  assert.ok(Math.hypot(p.x - c.x, p.z - c.z) >= c.r + 0.42 - 1e-6);
  const free = L.collide(L.SPAWN.x, L.SPAWN.z, 0.42);
  assert.deepEqual(free, { x: L.SPAWN.x, z: L.SPAWN.z }, "open floor is untouched");
});

test("camera clipping: a view line through a wall is cut at the wall, through a portal it isn't", () => {
  const walls = L.wallBoxes();
  assert.ok(L.clipSegment(-40, 3, -40, -6, walls) < 0.5, "front wall between portals stops the camera");
  assert.equal(L.clipSegment(-3, 3, -3, -6, walls), 1, "the portal is open");
});

test("multiplayer encoding round-trips to the centimetre and stays a unit vector", () => {
  for (const [x, z] of [[0, 0], [-83.9, -50.9], [81.7, 21.9], [12.34, -5.67]]) {
    const d = L.encodePos(x, z);
    assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12);
    const r = d.map((v) => Math.round(v * 1e5) / 1e5); // the server's rounding
    const back = L.decodePos(r);
    assert.ok(Math.abs(back.x - x) < 0.02 && Math.abs(back.z - z) < 0.02, `${x},${z} → ${back.x},${back.z}`);
  }
});

test("exhibitor corridor: 13 stations in order, facing in, no overlaps, a 6 m+ corridor clear of columns", () => {
  assert.deepEqual(L.STATIONS.map((s) => s.key), L.STATION_ORDER);
  assert.equal(L.STATIONS.length, 13);
  const boxes = L.STATIONS.map(L.stationBox);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      assert.ok(a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0, `${L.STATIONS[i].key} overlaps ${L.STATIONS[j].key}`);
    }
  for (const st of L.STATIONS) {
    const f = L.stationFront(st);
    assert.equal(L.zoneAt(f.x, f.z), 2, `${st.key}'s front is in Pavilion 2`);
    assert.ok(!L.solidBoxes().some((b) => f.x > b.x0 && f.x < b.x1 && f.z > b.z0 && f.z < b.z1), `${st.key}'s front is walkable`);
    // facing inward: the front is further from the wall than the station itself
    if (st.wall === "north") assert.ok(f.z > st.z);
    if (st.wall === "west") assert.ok(f.x > st.x);
    if (st.wall === "east") assert.ok(f.x < st.x);
  }
  const deepest = Math.max(...L.STATIONS.filter((s) => s.wall === "north").map((s) => s.z + s.d));
  const nearestColumn = Math.min(...L.COLUMNS.filter((c) => c.x > -36.75 && c.x < 30.75).map((c) => c.z - c.r));
  assert.ok(nearestColumn - deepest >= 6, `corridor is only ${nearestColumn - deepest} m wide`);
});

test("festival pavilion: replaces only the centre column; open, walkable inside, clear of the corridor and spawn", () => {
  const t = L.TENT;
  assert.ok(!L.COLUMNS.some((c) => L.inTent(c.x, c.z)), "no column inside the tent");
  assert.equal(L.COLUMNS.length, 12, "every other column kept");
  // a straight walk in from the front opening to the back counter, down the middle, hits nothing
  const blocked = (x, z) => L.solidBoxes().some((b) => x > b.x0 - 0.42 && x < b.x1 + 0.42 && z > b.z0 - 0.42 && z < b.z1 + 0.42);
  for (let z = t.z + t.d / 2 + 2; z > t.counters[0].z + 1.0; z -= 0.25) assert.ok(!blocked(t.x, z), `aisle blocked at z=${z}`);
  // and straight through from side to side at the middle
  for (let x = t.x - t.w / 2 - 1; x < t.x + t.w / 2 + 1; x += 0.25) assert.ok(!blocked(x, t.z + 0.6), `side passage blocked at x=${x}`);
  // the exhibitor corridor in front of the north stations stays at least 10 m clear of the tent
  const fronts = L.STATIONS.filter((s) => s.wall === "north").map((s) => L.stationFront(s).z);
  assert.ok(Math.max(...fronts) < t.z - t.d / 2 - 10);
  assert.ok(!L.inTent(L.SPAWN.x, L.SPAWN.z));
  assert.ok(t.canopy < L.HALL_H - 4, "canopy well under the 12 m ceiling");
});
