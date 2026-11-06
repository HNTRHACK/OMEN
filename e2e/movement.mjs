// Measures where each movement key takes KAI *on screen* (camera-relative), plus stuck-key checks.
// Usage: node e2e/movement.mjs [http://localhost:5173/]
import { launch, enter, finish, BASE as URL } from "./lib.mjs";
const browser = await launch();
const { page, logs } = await enter(browser, URL);

// open plaza ground, facing the relay, camera snapped behind
await page.evaluate(() => window.__omen.teleport(-3, 2.5, 0, -6));
await page.waitForTimeout(600);

const probe = () =>
  page.evaluate(() => {
    const o = window.__omen;
    const p = o.kai.group.position.clone();
    const cam = o.camera;
    const v = p.clone().project(cam);
    const viewDepth = p.clone().applyMatrix4(cam.matrixWorldInverse).z; // more negative = further away
    return { sx: v.x, sy: v.y, depth: viewDepth, world: p.toArray() };
  });

async function hold(key, ms = 1500) {
  await page.evaluate(() => window.__omen.teleport(-3, 2.5, 0, -6));
  await page.waitForTimeout(500);
  // camera axes at key-down, flattened onto the ground plane under KAI
  const before = await page.evaluate(() => {
    const o = window.__omen;
    const up = o.kai.group.position.clone().normalize();
    const e = o.camera.matrixWorld.elements;
    const flat = (x, y, z) => { const v = { x, y, z }; const d = v.x * up.x + v.y * up.y + v.z * up.z; const r = [v.x - up.x * d, v.y - up.y * d, v.z - up.z * d]; const l = Math.hypot(...r); return r.map((c) => c / l); };
    return { pos: o.kai.group.position.toArray(), right: flat(e[0], e[1], e[2]), fwd: flat(-e[8], -e[9], -e[10]) };
  });
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => window.__omen.kai.group.position.toArray());
  const d = after.map((x, i) => x - before.pos[i]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { right: +dot(d, before.right).toFixed(2), forward: +dot(d, before.fwd).toFixed(2), moved: +Math.hypot(...d).toFixed(2) };
}

const res = {};
for (const k of ["w", "s", "a", "d"]) res[k] = await hold(k);
// each key must move mostly along its own axis (>= 70% of the distance), in the right direction
const along = (r, axis, sign) => sign * r[axis] > 0.7 * r.moved && r.moved > 0.3;
const verdict = {
  W_forward: along(res.w, "forward", 1),
  S_backward: along(res.s, "forward", -1),
  A_left: along(res.a, "right", -1),
  D_right: along(res.d, "right", 1),
};
console.log(JSON.stringify(res));
console.log("VERDICT", JSON.stringify(verdict));

// stuck key: hold W, open the wallet sheet, release W inside it, close sheet → KAI must stand still
await page.evaluate(() => window.__omen.teleport(-3, 2.5, 0, -6));
await page.waitForTimeout(400);
await page.keyboard.down("w");
await page.waitForTimeout(200);
await page.evaluate(() => window.__omen.pay.openWallet());
await page.waitForTimeout(300);
await page.keyboard.up("w");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const s1 = await probe();
await page.waitForTimeout(900);
const s2 = await probe();
const drift = Math.hypot(...s2.world.map((x, i) => x - s1.world[i]));
const stuckOverlay = drift <= 0.05;
console.log("STUCK_KEY_AFTER_OVERLAY", stuckOverlay ? "PASS" : `FAIL (drifted ${drift.toFixed(2)} m)`);

// stuck key across a dialogue
await page.evaluate(() => window.__omen.teleport(-3, 2.5, 0, -6));
await page.keyboard.down("d");
await page.waitForTimeout(150);
await page.evaluate(() => { window.__omen.ui.say("NOTICE BOARD", "test"); return 1; });
await page.keyboard.up("d");
await page.evaluate(() => window.__omen.ui.closeDialogue());
await page.waitForTimeout(200);
const d1 = await probe();
await page.waitForTimeout(700);
const d2 = await probe();
const stuckDialogue = Math.hypot(...d2.world.map((x, i) => x - d1.world[i])) <= 0.05;
console.log("STUCK_KEY_AFTER_DIALOGUE", stuckDialogue ? "PASS" : "FAIL");
// Shift = run (faster than walk), Space = jump (leaves the ground, lands again)
const walk = await hold("w", 1200);
await page.evaluate(() => window.__omen.teleport(-3, 2.5, 0, -6));
await page.waitForTimeout(500);
const p0 = await page.evaluate(() => window.__omen.kai.group.position.toArray());
await page.keyboard.down("Shift");
await page.keyboard.down("w");
await page.waitForTimeout(1200);
await page.keyboard.up("w");
await page.keyboard.up("Shift");
await page.waitForTimeout(250);
const p1 = await page.evaluate(() => window.__omen.kai.group.position.toArray());
const run = Math.hypot(...p1.map((x, i) => x - p0[i]));
const runOk = run > walk.moved * 1.3;
console.log("RUN", runOk ? "PASS" : "FAIL", `walk ${walk.moved} m vs run ${run.toFixed(2)} m in 1.2 s`);
const r0 = await page.evaluate(() => window.__omen.kai.group.position.length());
await page.keyboard.press("Space");
let peak = 0;
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(60);
  peak = Math.max(peak, await page.evaluate(() => window.__omen.kai.group.position.length()));
}
await page.waitForTimeout(1200);
const r1 = await page.evaluate(() => window.__omen.kai.group.position.length());
const jumpOk = peak - r0 > 0.3 && Math.abs(r1 - r0) < 0.02;
console.log("JUMP", jumpOk ? "PASS" : "FAIL", `peak +${(peak - r0).toFixed(2)} m, landed ${(r1 - r0).toFixed(3)}`);
console.log("LOGS", logs.join("\n") || "none");
await browser.close();
finish({ ...verdict, stuckOverlay, stuckDialogue, runOk, jumpOk, noPageErrors: logs.length === 0 });
