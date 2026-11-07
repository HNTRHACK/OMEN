// The orange festival pavilion in a real browser: the four requested views, WASD walks into and
// through it, collisions with posts/counters/seating, the camera staying under the canopy, the
// counter prompt, and frame pacing.   E2E_GPU=1 SHOTS=dir node e2e/tent.mjs http://localhost:5183/
import { launch, BASE } from "./lib.mjs";

const shots = process.env.SHOTS;
const base = BASE.replace(/\/$/, "");
const checks = {};
const ok = (name, v) => (checks[name] = !!v);
const shot = (page, n) => shots && page.screenshot({ path: `${shots}/tent-${n}.png` }).catch(() => {});
const logs = [];

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
const page = await ctx.newPage();
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|WebSocket|socket\.io/i.test(m.text()) && logs.push(`console: ${m.text()}`));
await page.goto(`${base}/expo.html?auto`);
await page.waitForFunction(() => window.__expo?.mode === "play", null, { timeout: 120000 });
await page.waitForTimeout(1500);

const T = await page.evaluate(() => window.__expo.layout.TENT);
const put = (x, z, yaw, cam = {}) => page.evaluate(([x, z, yaw, cam]) => {
  const e = window.__expo;
  Object.assign(e.me, { x, z, yaw, y: 0, speed: 0 });
  e.cam.orbit = yaw - Math.PI;
  Object.assign(e.cam, { pitch: 0.32, dist: 8.5 }, cam);
}, [x, z, yaw, cam]);
const inside = () => page.evaluate(() => {
  const { me, layout: L } = window.__expo;
  return L.solidBoxes().some((b) => Math.hypot(me.x - Math.max(b.x0, Math.min(me.x, b.x1)), me.z - Math.max(b.z0, Math.min(me.z, b.z1))) < 0.4) || L.COLUMNS.some((c) => Math.hypot(me.x - c.x, me.z - c.z) < c.r + 0.4);
});
async function walk(target, ms = 15000) {
  const t0 = Date.now();
  let hit = false;
  await page.keyboard.down("w");
  while (Date.now() - t0 < ms) {
    const d = await page.evaluate(([tx, tz]) => {
      const e = window.__expo;
      const dx = tx - e.me.x;
      const dz = tz - e.me.z;
      e.cam.orbit = Math.atan2(-dx, -dz);
      return Math.hypot(dx, dz);
    }, [target.x, target.z]);
    if (await inside()) hit = true;
    if (d < 0.5) break;
    await page.waitForTimeout(60);
  }
  await page.keyboard.up("w");
  await page.waitForTimeout(200);
  const d = await page.evaluate(([tx, tz]) => Math.hypot(tx - window.__expo.me.x, tz - window.__expo.me.z), [target.x, target.z]);
  return { reached: d < 0.9, hit };
}

// ------------------------------------------------------------ views
await put(-3, 13, Math.PI, { pitch: 0.1, dist: 7.5 }); // the arrival point, as players spawn
await page.waitForTimeout(900);
await shot(page, "1-from-spawn");
const columnGone = await page.evaluate(() => !window.__expo.layout.COLUMNS.some((c) => window.__expo.layout.inTent(c.x, c.z)) && window.__expo.layout.COLUMNS.length === 12);
await put(T.x, T.z + T.d / 2 + 7, Math.PI, { pitch: 0.08, dist: 6 });
await page.waitForTimeout(800);
await shot(page, "2-entrance");
await put(T.x - 4.8, T.z + 3.6, Math.PI - 0.75, { pitch: 0.05, dist: 3.2 });
await page.waitForTimeout(800);
await shot(page, "3-inside");
await put(T.x + T.w / 2 + 6, T.z + 4, -Math.PI / 2 - 0.5, { pitch: 0.1, dist: 7 });
await page.waitForTimeout(800);
await shot(page, "4-side");
ok("1 the centre column is replaced by the pavilion; every other column is kept", columnGone);

// ------------------------------------------------------------ walking in and through
await put(T.x, T.z + T.d / 2 + 6, Math.PI);
const inFront = await walk({ x: T.x, z: T.counters[0].z + 1.4 }); // in through the front, down the aisle
const prompt = (await page.isVisible("#prompt")) ? await page.textContent("#prompt-text") : "";
await page.keyboard.press("e");
await page.waitForTimeout(400);
const toastText = (await page.isVisible("#toast")) ? await page.textContent("#toast") : "";
const crossW = await walk({ x: T.x - T.w / 2 - 3, z: T.z + 0.6 }); // out through the west side
const crossE = await walk({ x: T.x + T.w / 2 + 3, z: T.z + 0.6 }); // back across and out the east side
console.log("WALK", JSON.stringify({ inFront, crossW, crossE, prompt, toast: toastText.slice(0, 40) }));
ok("2 WASD walks in through the front to the counter and right across through both sides without clipping anything", inFront.reached && crossW.reached && crossE.reached && !inFront.hit && !crossW.hit && !crossE.hit);
ok("3 the counter offers an E interaction", /Festival Pavilion/.test(prompt) && /Festival Pavilion/.test(toastText));

// ------------------------------------------------------------ collisions
const bumps = [];
const posts = await page.evaluate(() => window.__expo.layout.tentPosts());
for (const [name, x, z, yaw] of [["post", posts[2].x + 2.5, posts[2].z + 0.2, -Math.PI / 2], ["back counter", T.x, T.counters[0].z + 2.5, Math.PI], ["seating", T.tables[0].x + 2.6, T.tables[0].z, -Math.PI / 2], ["side counter", T.counters[1].x + 2.5, T.counters[1].z, -Math.PI / 2]]) {
  await put(x, z, yaw);
  let hit = false;
  await page.keyboard.down("w");
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(140);
    if (await inside()) hit = true;
  }
  await page.keyboard.up("w");
  const me = await page.evaluate(() => [window.__expo.me.x, window.__expo.me.z].map((v) => +v.toFixed(2)));
  bumps.push({ name, hit, me });
}
console.log("BUMPS", JSON.stringify(bumps));
ok("4 posts, counters and seating stop the player (never inside them)", bumps.every((b) => !b.hit));

// ------------------------------------------------------------ camera inside: never above the canopy
await put(T.x, T.z + 1, Math.PI);
const camBad = [];
for (let a = 0; a < 12; a++) {
  const r = await page.evaluate((a) => new Promise((res) => {
    const e = window.__expo;
    Object.assign(e.cam, { orbit: (a / 12) * Math.PI * 2, pitch: 0.9, dist: 16 });
    requestAnimationFrame(() => requestAnimationFrame(() => res({ y: e.camera.position.y, inT: e.layout.inTent(e.camera.position.x, e.camera.position.z) })));
  }), a);
  if (r.y > T.canopy - 0.9) camBad.push(r);
}
await page.evaluate(() => Object.assign(window.__expo.cam, { pitch: 0.32, dist: 8.5 }));
console.log("CAMERA", camBad.length ? JSON.stringify(camBad.slice(0, 3)) : "under the canopy at all 12 angles");
ok("5 inside the tent the camera stays under the canopy even at max zoom and steep pitch", camBad.length === 0);

// ------------------------------------------------------------ frame pacing looking at the tent
await put(T.x, T.z + T.d / 2 + 5, Math.PI);
const perf = await page.evaluate(() => window.__expo.sample(4000));
console.log("PERF", JSON.stringify({ avgFps: +perf.avgFps.toFixed(1), p99: +perf.p99.toFixed(1), worst: +perf.worst.toFixed(1), calls: perf.calls, triangles: perf.triangles, gpu: perf.gpu }));
ok("6 frame pacing measured facing the pavilion", perf.frames > 60);

for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await browser.close();
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length || logs.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
process.exit(failed.length || logs.length ? 1 : 0);
