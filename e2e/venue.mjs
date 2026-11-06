// Venue phase 1 (expo.html): the arrival hall, branching columns, lighting and the Main Stage.
// Two real browsers: render, walk, climb the stage, bump into walls/seats/stage edge, sweep the
// camera for clipping, see each other, interact, and measure frame pacing (not just average FPS).
//   E2E_GPU=1 node e2e/venue.mjs http://localhost:5182/
import { launch, BASE } from "./lib.mjs";

const shots = process.env.SHOTS;
const base = BASE.replace(/\/$/, "");
const checks = {};
const ok = (name, v) => (checks[name] = !!v);
const shot = (page, n) => shots && page.screenshot({ path: `${shots}/venue-${n}.png` }).catch(() => {});
const logs = [];

async function open(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => logs.push(`${name} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && logs.push(`${name} console: ${m.text()}`));
  await page.goto(`${base}/expo.html`);
  await page.waitForSelector("#ex-name", { timeout: 120000 });
  await page.waitForFunction(() => !!window.__expo, null, { timeout: 120000 });
  await page.fill("#ex-name", name);
  await page.click("#ex-enter");
  await page.waitForFunction(() => window.__expo.mode === "play" && window.__expo.net.connected, null, { timeout: 60000 });
  return page;
}
const state = (page) => page.evaluate(() => ({ ...window.__expo.me }));
const put = (page, x, z, yaw) => page.evaluate(([x, z, yaw]) => Object.assign(window.__expo.me, { x, z, yaw, y: window.__expo.layout.groundAt(x, z), speed: 0 }) && (window.__expo.cam.orbit = yaw - Math.PI), [x, z, yaw]);
async function hold(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
  await page.waitForTimeout(150);
}
/** Is the player (radius 0.42) overlapping anything solid? Checked against the real layout data. */
const inside = (page) =>
  page.evaluate(() => {
    const { me, layout: L } = window.__expo;
    const r = 0.4;
    const hitBox = L.solidBoxes().some((b) => me.x > b.x0 - r && me.x < b.x1 + r && me.z > b.z0 - r && me.z < b.z1 + r && Math.hypot(me.x - Math.max(b.x0, Math.min(me.x, b.x1)), me.z - Math.max(b.z0, Math.min(me.z, b.z1))) < r);
    const hitCol = L.COLUMNS.some((c) => Math.hypot(me.x - c.x, me.z - c.z) < c.r + r);
    return hitBox || hitCol;
  });

const [bA, bB] = await Promise.all([launch(), launch()]);
const A = await open(bA, "Asha");
const B = await open(bB, "Ravi");

// ------------------------------------------------------------ 1. it loads and renders
await A.waitForTimeout(1500);
const info = await A.evaluate(() => ({ calls: window.__expo.renderer.info.render.calls, tris: window.__expo.renderer.info.render.triangles, cols: window.__expo.scene.getObjectByName("tree-columns")?.children.length, chairs: window.__expo.stage.seats }));
await shot(A, "1-arrival");
ok("1 the venue loads and renders (columns instanced, ~400 chairs in one draw)", info.calls > 10 && info.tris > 1000 && info.cols >= 1 && info.chairs > 300);

// ------------------------------------------------------------ 2. walking + both players see each other
const s0 = await state(A);
await hold(A, ["w"], 1500);
const s1 = await state(A);
const walked = s1.z < s0.z - 3 && Math.abs(s1.x - s0.x) < 1.5; // spawn faces north: W walks north
const seen = await B.waitForFunction(() => [...window.__expo.net.remotes.values()].some((r) => r.name === "Asha" && r.c.group.visible), null, { timeout: 15000 }).then(() => true, () => false);
const close = await B.evaluate(([x, z]) => {
  const r = [...window.__expo.net.remotes.values()].find((q) => q.name === "Asha");
  return r ? Math.hypot(r.c.group.position.x - x, r.c.group.position.z - z) : 99;
}, [s1.x, s1.z]);
ok("2 WASD walks camera-relative; the other player sees Asha where she really is", walked && seen && close < 1.5);

// ------------------------------------------------------------ 3. the Main Stage: climb the side steps, walk off the front edge
await A.keyboard.press("1"); // quick travel to Pavilion 1
await A.waitForTimeout(700);
const atP1 = await state(A);
await shot(A, "2-main-stage-from-portal");
const L = await A.evaluate(() => ({ stage: window.__expo.layout.STAGE }));
const st = L.stage;
await put(A, st.steps.x0 - 1.2, (st.steps.z0 + st.steps.z1) / 2, Math.PI / 2); // facing east, up the steps
await hold(A, ["w"], 1400);
const onDeck = await state(A);
await shot(A, "3-on-stage");
// walk south off the front edge: drop back to the floor
await put(A, onDeck.x, onDeck.z, 0); // turn to face south (camera too)
await hold(A, ["w"], 1600);
const offDeck = await state(A);
console.log("STAGE", JSON.stringify({ atP1: [atP1.x, atP1.z].map((v) => +v.toFixed(1)), onDeck: [onDeck.x, onDeck.y, onDeck.z].map((v) => +v.toFixed(2)), offDeck: [offDeck.x, offDeck.y, offDeck.z].map((v) => +v.toFixed(2)) }));
ok("3 quick travel to the stage; the side steps lead up onto the 1.1 m deck; walking off the edge drops to the floor", atP1.x < -50 && onDeck.y > 1.0 && onDeck.x > st.x0 && offDeck.y < 0.05);

// the deck edge is a wall from below (no walking up its 1.1 m face)
await put(A, -60, st.z1 + 3, Math.PI); // in front of the stage, facing north
await hold(A, ["w"], 1500);
const blocked = await state(A);
ok("4 the stage front can't be walked up from the floor", blocked.y < 0.05 && blocked.z > st.z1);

// ------------------------------------------------------------ 4. collisions: walls, seating, columns, dividers
const tests = [
  ["front wall from the concourse", -40, 3, Math.PI],
  ["north wall", -20, -45, Math.PI],
  ["west wall", -80, -5, -Math.PI / 2],
  ["seating block", -66, -18, Math.PI],
  ["operable wall", -45, -8, Math.PI / 2],
  ["tree column", -79, -6, Math.PI],
  ["glazed facade", 20, 18, 0],
];
const collisions = [];
for (const [name, x, z, yaw] of tests) {
  await put(A, x, z, yaw);
  let hit = false;
  for (const k of ["w", "Shift"]) await A.keyboard.down(k);
  for (let i = 0; i < 10; i++) {
    await A.waitForTimeout(160);
    if (await inside(A)) hit = true;
  }
  for (const k of ["w", "Shift"]) await A.keyboard.up(k);
  const s = await state(A);
  const zone = await A.evaluate(([x, z]) => window.__expo.layout.zoneAt(x, z), [s.x, s.z]);
  collisions.push({ name, hit, x: +s.x.toFixed(2), z: +s.z.toFixed(2), zone });
}
console.log("COLLISIONS", JSON.stringify(collisions));
ok("5 walls, seating, columns, operable walls and the facade all stop the player (never inside anything)", collisions.every((c) => !c.hit && c.zone !== -1));

// ------------------------------------------------------------ 5. camera never clips through walls
const camSpots = [[-60, -46.5, 0], [-82.5, -5, Math.PI], [-37.8, -45, 0], [80.5, 20.5, Math.PI], [-3, 1.2, 0]];
const camBad = [];
for (const [x, z, yaw] of camSpots) {
  await put(A, x, z, yaw);
  await A.waitForTimeout(120);
  for (let a = 0; a < 16; a++) {
    const r = await A.evaluate((a) => {
      const { cam, camera, layout: L, me } = window.__expo;
      cam.orbit = (a / 16) * Math.PI * 2;
      cam.dist = 16;
      cam.pitch = 0.25;
      return new Promise((res) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const p = camera.position;
            const walls = L.wallBoxes().concat(L.propBoxes().filter((b) => b.kind === "screen"));
            const inWall = walls.some((b) => p.x > b.x0 - 0.05 && p.x < b.x1 + 0.05 && p.z > b.z0 - 0.05 && p.z < b.z1 + 0.05);
            const out = p.x < L.BOUNDS.x0 || p.x > L.BOUNDS.x1 || p.z < L.BOUNDS.z0 || p.z > L.BOUNDS.z1;
            // the camera must also stay on the player's side of the front wall (no seeing through it)
            // (looking through an open portal is fine: check where the view line crosses z = 0)
            const cx = me.x + ((p.x - me.x) * (0 - me.z)) / (p.z - me.z || 1e-9);
            const crossed = Math.sign(p.z) !== Math.sign(me.z) && Math.abs(p.z) > 0.4 && !L.portals.some((q) => cx > q.x0 + 0.3 && cx < q.x1 - 0.3);
            const ceil = p.y > (p.z < 0 ? L.HALL_H : L.CONCOURSE_H) - 0.3;
            res({ inWall, out, crossed, ceil, p: [p.x, p.y, p.z].map((v) => +v.toFixed(2)) });
          }),
        ),
      );
    }, a);
    if (r.inWall || r.out || r.crossed || r.ceil) camBad.push({ spot: [x, z], a, ...r });
  }
}
await A.evaluate(() => Object.assign(window.__expo.cam, { dist: 8.5, pitch: 0.32 }));
console.log("CAMERA", camBad.length ? JSON.stringify(camBad.slice(0, 5)) : "no clipping in 80 samples");
ok("6 camera sweep (5 wall-hugging spots × 16 angles at max zoom): never inside a wall, outside the hall or above the ceiling", camBad.length === 0);

// ------------------------------------------------------------ 6. interactions + map
await put(A, 76.5, 11, Math.PI / 2);
await A.waitForTimeout(400);
const doorPrompt = await A.textContent("#prompt-text");
await A.keyboard.press("m");
const mapOpen = await A.isVisible("#expo-map");
await shot(A, "4-map");
await A.keyboard.press("Escape");
ok("7 the village doorway offers a way back; the map opens with M", /Blockhaven village/.test(doorPrompt) && mapOpen);

// ------------------------------------------------------------ 7. views for the report
const views = [
  ["5-arrival-arch", -3, 6, 0, 0.12, 9], // looking south: the arch and the daylit facade
  ["5b-concourse-led", -31.7, 14, Math.PI, 0.02, 7], // the LED wall between portals 1 and 2
  ["6-columns-and-ceiling", -3, -2, Math.PI, 0.05, 6],
  ["7-main-stage-audience", -60.4, -18, Math.PI, 0.12, 7],
  ["8-stage-deck", -66, -45, Math.PI / 2 + 0.6, 0.2, 7],
];
for (const [n, x, z, yaw, pitch, dist] of views) {
  await put(A, x, z, yaw);
  await A.evaluate(([p, d]) => Object.assign(window.__expo.cam, { pitch: p, dist: d }), [pitch, dist]);
  await A.waitForTimeout(700);
  await shot(A, n);
}

// ------------------------------------------------------------ 8. frame pacing while moving (both browsers running)
await A.evaluate(() => Object.assign(window.__expo.cam, { pitch: 0.32, dist: 8.5 }));
await put(A, -3, 12, Math.PI);
for (const k of ["w", "Shift"]) await A.keyboard.down(k);
const sampleP = A.evaluate(() => window.__expo.sample(6000));
for (let i = 0; i < 6; i++) {
  await A.keyboard.down(i % 2 ? "a" : "d");
  await A.waitForTimeout(900);
  await A.keyboard.up(i % 2 ? "a" : "d");
}
const perf = await sampleP;
for (const k of ["w", "Shift"]) await A.keyboard.up(k);
console.log("PERF", JSON.stringify({ ...perf, avgFps: +perf.avgFps.toFixed(1), p50: +perf.p50.toFixed(1), p95: +perf.p95.toFixed(1), p99: +perf.p99.toFixed(1), worst: +perf.worst.toFixed(1) }));
ok("8 frame pacing measured while running through the hall", perf.frames > 60);

for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await Promise.all([bA.close(), bB.close()]);
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length || logs.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
process.exit(failed.length || logs.length ? 1 : 0);
