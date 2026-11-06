// The exhibitor corridor (Pavilion 2, north wall + corners), in a real browser.
// Walks the whole corridor in order with real WASD key presses (steering only by turning the
// camera, like a player with a mouse), presses E at every station, and checks that nothing is
// ever walked into. Runs without a backend; with one, the Mentor Station reaches Alfred.
//   E2E_GPU=1 SHOTS=dir node e2e/exhibitors.mjs http://localhost:5183/
import { launch, BASE } from "./lib.mjs";

const shots = process.env.SHOTS;
const base = BASE.replace(/\/$/, "");
const checks = {};
const ok = (name, v) => (checks[name] = !!v);
const shot = (page, n) => shots && page.screenshot({ path: `${shots}/exhibitors-${n}.png` }).catch(() => {});
const logs = [];

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
const page = await ctx.newPage();
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|WebSocket|socket\.io/i.test(m.text()) && logs.push(`console: ${m.text()}`));
await page.goto(`${base}/expo.html?auto`);
await page.waitForFunction(() => window.__expo?.mode === "play", null, { timeout: 120000 });
await page.waitForTimeout(1200);

const put = (x, z, yaw, cam = {}) => page.evaluate(([x, z, yaw, cam]) => {
  const e = window.__expo;
  Object.assign(e.me, { x, z, yaw, y: 0, speed: 0 });
  e.cam.orbit = yaw - Math.PI;
  Object.assign(e.cam, { pitch: 0.32, dist: 8.5 }, cam);
}, [x, z, yaw, cam]);
const stations = await page.evaluate(() => window.__expo.corridor.stations.map((s) => ({ key: s.key, name: s.name, kind: s.kind, front: s.front, wall: s.wall, x: s.x, z: s.z, yaw: s.yaw })));
const order = await page.evaluate(() => window.__expo.layout.STATION_ORDER);

// ------------------------------------------------------------ 1. the wall from the player's view in Pavilion 2
await put(-8, -22, Math.PI, { pitch: 0.12, dist: 7 });
await page.waitForTimeout(800);
await shot(page, "1-the-wall");
const faceIn = stations.every((s) => (s.wall === "north" ? s.yaw === 0 : s.wall === "west" ? s.yaw > 0 : s.yaw < 0));
const sameOrder = JSON.stringify(stations.map((s) => s.key)) === JSON.stringify(order);
ok("1 thirteen stations, in the requested order, all facing into the hall", stations.length === 13 && sameOrder && faceIn);

// ------------------------------------------------------------ 2. walk the corridor with WASD, press E at every station
async function walkTo(t, maxMs = 20000) {
  const t0 = Date.now();
  let bumped = false;
  await page.keyboard.down("w");
  while (Date.now() - t0 < maxMs) {
    const r = await page.evaluate(([tx, tz]) => {
      const e = window.__expo;
      const dx = tx - e.me.x;
      const dz = tz - e.me.z;
      e.cam.orbit = Math.atan2(-dx, -dz); // look where we want to go; W walks camera-forward
      const L = e.layout;
      const rr = 0.4;
      const inside = L.solidBoxes().some((b) => Math.hypot(e.me.x - Math.max(b.x0, Math.min(e.me.x, b.x1)), e.me.z - Math.max(b.z0, Math.min(e.me.z, b.z1))) < rr - 0.02) || L.COLUMNS.some((c) => Math.hypot(e.me.x - c.x, e.me.z - c.z) < c.r + rr - 0.02);
      return { d: Math.hypot(dx, dz), inside };
    }, [t.x, t.z]);
    if (r.inside) bumped = true;
    if (r.d < 0.6) break;
    await page.waitForTimeout(60);
  }
  await page.keyboard.up("w");
  await page.waitForTimeout(250);
  const d = await page.evaluate(([tx, tz]) => Math.hypot(tx - window.__expo.me.x, tz - window.__expo.me.z), [t.x, t.z]);
  return { reached: d < 1.0, bumped };
}

await put(-20, -30, -Math.PI / 2); // in Pavilion 2, near the west opening of the corridor
const visits = [];
for (const [i, st] of stations.entries()) {
  const w = await walkTo(st.front);
  // face the counter before pressing E
  await page.evaluate((yaw) => (window.__expo.me.yaw = yaw), st.yaw + Math.PI);
  await page.waitForTimeout(250);
  const prompt = (await page.isVisible("#prompt")) ? await page.textContent("#prompt-text") : "";
  const at = await page.evaluate(() => window.__expo.interactAt());
  await page.keyboard.press("e");
  await page.waitForTimeout(450);
  const sheet = await page.isVisible("#station");
  const toastText = (await page.isVisible("#toast")) ? await page.textContent("#toast") : "";
  let extra = "";
  const opened = await page.evaluate(() => window.__expo.panel.current);
  if (sheet && opened !== st.key) console.log(`  ${st.key}: E opened "${opened}" instead`, await page.evaluate(() => [window.__expo.me.x, window.__expo.me.z].map((v) => v.toFixed(2))));
  if (st.key === "arkiv" && sheet) {
    await page.fill("#ark-f [name=owner]", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    await page.click("#ark-f button");
    await page.waitForFunction(() => !/Asking Arkiv/.test(document.querySelector("#ark-out")?.textContent || "Asking Arkiv"), null, { timeout: 30000 }).catch(() => {});
    extra = (await page.textContent("#ark-out")).replace(/\s+/g, " ").slice(0, 120);
    await shot(page, "4-arkiv-panel");
  }
  if (st.kind === "mentor" && sheet) {
    await shot(page, "3b-mentor-station-panel");
    await page.fill("#mentor-f [name=q]", "How do I find my first customer?");
    await page.click("#mentor-f button");
    await page.waitForFunction(() => !/thinking/.test(document.querySelector("#mentor-out")?.textContent || "thinking"), null, { timeout: 30000 }).catch(() => {});
    extra = (await page.textContent("#mentor-out")).replace(/\s+/g, " ").slice(0, 120);
  }
  if (sheet) await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const responded = st.kind === "food" || st.kind === "washroom" ? /chai|Washrooms/.test(toastText) : sheet;
  visits.push({ i: i + 1, key: st.key, ...w, prompt, at, responded, extra });
  if (st.key === "washroom") {
    await page.evaluate(() => (window.__expo.cam.orbit = -Math.PI / 2 + 0.5)); // look east along the corridor
    await page.evaluate(() => Object.assign(window.__expo.cam, { pitch: 0.16, dist: 7 }));
    await page.waitForTimeout(600);
    await shot(page, "2-walking-the-corridor");
    await page.evaluate(() => Object.assign(window.__expo.cam, { pitch: 0.32, dist: 8.5 }));
  }
}
for (const v of visits) console.log(`${String(v.i).padStart(2)} ${v.key.padEnd(11)} reached=${v.reached} bumped=${v.bumped} E→${v.responded ? "ok" : "NO"} prompt="${v.prompt}"${v.extra ? ` | ${v.extra}` : ""}`);
ok("2 every station is reachable by walking with WASD, in order, without walking into anything", visits.every((v) => v.reached && !v.bumped));
ok("3 every station shows its E prompt and responds to E", visits.every((v) => v.prompt && v.responded));
ok("4 Arkiv runs a real read-only lookup (records, or an honest 'unreachable'); Mentor reaches Alfred or says he isn't reachable", /record|Arkiv couldn.t be reached/.test(visits.find((v) => v.key === "arkiv").extra || "") && /\S/.test(visits.find((v) => v.key === "mentor").extra));

// ------------------------------------------------------------ 3. look back along the corridor from the far end
const arkivSt = stations.find((s) => s.key === "arkiv");
await put(arkivSt.front.x - 2, arkivSt.front.z - 1.5, -Math.PI / 2);
await page.evaluate(() => Object.assign(window.__expo.cam, { orbit: Math.PI / 2 - 0.55 + Math.PI, pitch: 0.16, dist: 6.5 }));
await page.waitForTimeout(700);
await shot(page, "5-looking-back-from-arkiv");
// a closer look at the facilities
const food = stations.find((s) => s.key === "food");
await put(food.front.x + 1.5, food.front.z + 2.5, Math.PI, { pitch: 0.14, dist: 6 });
await page.evaluate(() => (window.__expo.cam.orbit = -0.35));
await page.waitForTimeout(700);
await shot(page, "6-food-and-washroom");
const mentorSt = stations.find((s) => s.kind === "mentor");
await put(mentorSt.front.x - 1, mentorSt.front.z + 2.5, Math.PI, { pitch: 0.18, dist: 6 });
await page.waitForTimeout(700);
await shot(page, "3-mentor-station");

// the blue band is still visible above the stations (nothing taller than 5.1 m against the wall)
const tallest = await page.evaluate(() => {
  const b = new window.__expo.THREE.Box3().setFromObject(window.__expo.corridor.root);
  return b.max.y;
});
ok("5 the stations stay below the blue decorative band (top of stations < 6.3 m)", tallest < 6.3);
const perf = await page.evaluate(() => window.__expo.sample(3000));
console.log("PERF", JSON.stringify({ avgFps: +perf.avgFps.toFixed(1), p99: +perf.p99.toFixed(1), calls: perf.calls, triangles: perf.triangles, gpu: perf.gpu }));

for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await browser.close();
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length || logs.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
process.exit(failed.length || logs.length ? 1 : 0);
