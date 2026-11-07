// Venue-first Bounty Royale: two verified players click ENTER BOUNTY ROYALE, arrive OUTSIDE the
// Mumbai venue (a separate scene), see each other, each WALK (real key presses) to Pavilion 2, get
// "Press E — Open Bounty Royale", open it, stake, close it and are still standing where they were.
// A refresh puts them back near Pavilion 2 with the same points (no new account, no second grant).
//   (start e2e/royale-harness.mjs first) E2E_GPU=1 SHOTS=dir node e2e/royale-venue.mjs http://localhost:5195/
import { chromium, devices } from "playwright-core";
import { BASE, passGate } from "./lib.mjs";

const base = BASE.replace(/\/$/, "");
const shots = process.env.SHOTS;
const checks = {};
const ok = (k, v, extra = "") => ((checks[k] = !!v), !v && extra && console.log("  detail:", k, extra));
const logs = [];
const GPU = process.env.E2E_GPU ? ["--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const shot = (p, n) => shots && p.screenshot({ path: `${shots}/venue-${n}.png` }).catch(() => {});

async function player(label, device, name) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: GPU });
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1280, height: 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => logs.push(`${label} pageerror: ${e.message} @ ${page.url().split("/").pop()} ${(e.stack || "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon|WebSocket/i.test(m.text()) && logs.push(`${label} console: ${m.text()}`));
  await page.goto(base + "/");
  const nullifier = String(BigInt("0x" + crypto.randomUUID().replaceAll("-", "")));
  const v = await page.evaluate((nl) => fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result: { action: "play-omen", environment: "staging", responses: [{ identifier: "orb", nullifier: nl }] } }) }).then((r) => r.json()), nullifier);
  await page.evaluate((n) => localStorage.setItem("omen.courier", JSON.stringify({ name: n })), name);
  await page.reload();
  await passGate(page);
  return { browser, page, name, human: v.human, label };
}
const expo = (p, fn, arg) => p.page.evaluate(fn, arg);
const pos = (p) => expo(p, () => ({ x: window.__expo.me.x, z: window.__expo.me.z, yaw: window.__expo.me.yaw }));

async function enterRoyale(p) {
  await p.page.waitForSelector("#title:not([hidden]) #royale-enter", { timeout: 120000 });
  await p.page.click("#royale-enter");
  await p.page.waitForURL(/expo\.html\?.*royale=1/);
  await p.page.waitForFunction(() => window.__expo?.mode === "play" && window.__expo.net.connected, null, { timeout: 120000 });
}

/** Walk with real key presses toward Pavilion 2's arena until its prompt appears. */
async function walkToArena(p) {
  const L = await expo(p, () => ({ tx: window.__expo.layout.TENT.x }));
  for (let step = 0; step < 300; step++) {
    if ((await expo(p, () => window.__expo.interactAt())) === "royale") break;
    const me = await pos(p);
    // steer: face north (yaw π = forward (0,-1)) and drift toward the arena's centre line
    // keep right of the venue-guide board on the concourse, then line up with the arena
    const tx = me.z > 3 ? L.tx + 1.8 : L.tx;
    const key = Math.abs(me.x - tx) > 0.6 ? (me.x < tx ? "d" : "a") : "w";
    await expo(p, () => (window.__expo.cam.orbit = 0)); // camera behind, looking north
    await p.page.keyboard.down(key);
    await p.page.waitForTimeout(120);
    await p.page.keyboard.up(key);
  }
  return expo(p, () => window.__expo.interactAt());
}

const A = await player("A", null, "Asha");
const B = await player("B", "Pixel 7", "Ravi");
await Promise.all([enterRoyale(A), enterRoyale(B)]);
const [a0, b0] = [await pos(A), await pos(B)];
await shot(A.page, "1-A-arrival");
await shot(B.page, "1-B-arrival");
ok("1 ENTER BOUNTY ROYALE loads the separate Mumbai venue scene, outside the pavilions, with no prediction UI open", a0.z > 0 && b0.z > 0 && !(await expo(A, () => window.__expo.arena.isOpen)) && (await A.page.isHidden("#royale")), JSON.stringify([a0, b0]));
const lookOf = (p) => expo(p, () => window.__expo.kai.look);
const [la, lb] = [await lookOf(A), await lookOf(B)];
ok("2 each wears its persistent server-assigned avatar", Object.entries(A.human.look).every(([k, v]) => la[k] === v) && Object.entries(B.human.look).every(([k, v]) => lb[k] === v));
const seeEach = await Promise.all([A, B].map((p) => p.page.waitForFunction(() => window.__expo.net.remotes.size >= 1, null, { timeout: 20000 }).then(() => true, () => false)));
const countA = await A.page.textContent("#online");
ok("3 both see each other in the Mumbai room, with an accurate live count", seeEach.every(Boolean) && /^2 in the venue/.test(countA), countA);

// both walk to Pavilion 2 independently and at the same time
const [ia, ib] = await Promise.all([walkToArena(A), walkToArena(B)]);
const promptA = await A.page.textContent("#prompt-text");
await shot(A.page, "2-A-pavilion2-prompt");
await shot(B.page, "2-B-pavilion2-prompt");
ok("4 walking into Pavilion 2's arena shows 'Press E — Open Bounty Royale' (both players)", ia === "royale" && ib === "royale" && promptA === "Press E — Open Bounty Royale", JSON.stringify({ ia, ib, promptA, a: await pos(A), b: await pos(B) }));
const remoteSeesWalk = await expo(A, () => [...window.__expo.net.remotes.values()][0]?.c.group.position.z);
ok("5 A sees B's courier move through the venue (synchronised movement)", remoteSeesWalk < -10, String(remoteSeesWalk));

// open with E; the avatar must not move while the overlay is used
await A.page.waitForTimeout(800); // let the walk's momentum settle before measuring
const at = await pos(A);
await A.page.keyboard.press("e");
await A.page.waitForSelector("#royale .ra-card h2");
await A.page.click("[data-join]");
await A.page.waitForSelector("[data-balance]");
await A.page.keyboard.down("w"); // keys pressed while the arena is open are ignored
await A.page.waitForTimeout(400);
await A.page.keyboard.up("w");
await shot(A.page, "3-A-arena-open");
const balA = await A.page.textContent("[data-balance]");
const onlineA = await A.page.textContent("[data-online]");
ok("6a the arena's online count is one per player page (2)", onlineA === "2", onlineA);
await A.page.click(".ra-x");
await A.page.waitForTimeout(300);
const after = await pos(A);
ok("6 E opens Bounty Royale; 1,000 points granted; typing/keys don't move the avatar; closing returns to the same spot", balA === "1,000" && Math.hypot(after.x - at.x, after.z - at.z) < 0.01, JSON.stringify({ balA, at, after }));

// ------------------------------------------------------------ prediction submission (DEMO teams)
const modPost = async (path, body, cookie) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, cookie: r.headers.get("set-cookie")?.split(";")[0] };
};
const M = (await modPost("/api/mod/login", { username: "royale-mod", password: "harness-moderator-pass" })).cookie;
ok("6b DEMO teams need a moderator; then they are on", (await modPost("/api/royale/mod/demo", { enabled: true })).status === 401 && (await modPost("/api/royale/mod/demo", { enabled: true }, M)).status === 200);
await A.page.keyboard.press("e");
await A.page.waitForSelector("#royale .ra-demo");
await A.page.click('[data-tab="bounty"]');
await A.page.click('[data-sponsor="bounty-chainlink"]');
await A.page.click('[data-market="bounty-chainlink"] [data-pick="demo-team-a"]');
await A.page.waitForSelector(".ra-confirm .ra-big");
const sum = (await A.page.textContent(".ra-confirm")).replace(/\s+/g, " ");
await A.page.fill(".ra-confirm input[name=amount]", "250");
await shot(A.page, "3b-A-confirm");
const afterTxt = await A.page.textContent("[data-after]");
await A.page.click(".ra-confirm .ra-big");
await A.page.waitForSelector(".ra-receipt");
const rec = (await A.page.textContent(".ra-receipt")).replace(/\s+/g, " ");
await shot(A.page, "3c-A-receipt");
ok("6c confirm panel shows team, sponsor bounty, lock deadline and balance after; receipt after CONFIRM PREDICTION", /DEMO Team A/.test(sum) && /Sponsor bounty ?Chainlink/.test(sum) && /Locks/.test(sum) && afterTxt === "750 available" && /Prediction locked/.test(rec) && /250 pts/.test(rec) && /750 pts/.test(rec), sum + " | " + rec);
await A.page.click("[data-receipt-ok]");
const mine = await A.page.textContent(".ra-hist");
ok("6d My picks shows the locked prediction; balances updated", /Chainlink bounty winners/.test(mine) && /DEMO Team A/.test(mine) && (await A.page.textContent("[data-balance]")) === "750");
const over = await A.page.evaluate(() => fetch("/api/royale/predictions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketId: "top3", selection: "demo-team-b", amount: 900, idempotencyKey: "overspend-1" }) }).then((r) => r.json()));
ok("6e overspending is refused by the server", over.error === "insufficient_points");
await A.page.click(".ra-x");

// B opens on the phone (the on-screen E button), stakes nothing yet; A's scoreboard updates live
await B.page.click("#act");
await B.page.waitForSelector("#royale .ra-card h2");
await B.page.click("[data-join]");
await B.page.waitForSelector("[data-balance]");
const liveOnB = await B.page.waitForFunction(() => /Asha<\/b> put 250 on DEMO Team A/.test(document.querySelector(".ra-activity")?.innerHTML || ""), null, { timeout: 10000 }).then(() => true, () => false);
await B.page.click('[data-tab="board"]');
const boardB = (await B.page.textContent(".ra-board")).replace(/\s+/g, " ");
await shot(B.page, "4-B-arena-open");
ok("6f B sees A's prediction in live activity and A on the leaderboard", liveOnB && /Asha/.test(boardB), boardB);
await B.page.click(".ra-x");
const board = await A.page.waitForFunction(() => window.__expo.royale.state?.leaderboard.length >= 2, null, { timeout: 10000 }).then(() => true, () => false);
await shot(A.page, "5-A-scoreboard");
ok("7 the arena scoreboard in Pavilion 2 shows both players live", board);

// refresh A: back near Pavilion 2, same identity, no second grant, multiplayer intact
const before = await pos(A);
await A.page.reload();
await A.page.waitForFunction(() => window.__expo?.mode === "play" && window.__expo.net.connected, null, { timeout: 120000 });
await A.page.waitForTimeout(500);
const back = await pos(A);
await A.page.keyboard.press("e");
await A.page.waitForSelector("#royale [data-balance]");
const balAfter = await A.page.textContent("[data-balance]");
const stillSee = await A.page.waitForFunction(() => window.__expo.net.remotes.size >= 1, null, { timeout: 15000 }).then(() => true, () => false);
await shot(A.page, "6-A-after-refresh");
ok("8 after a refresh A is back at Pavilion 2 (same spot), same balance (750), still sees B", Math.hypot(back.x - before.x, back.z - before.z) < 1.5 && balAfter === "750" && stillSee, JSON.stringify({ before, back, balAfter }));

for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await Promise.all([A.browser.close(), B.browser.close()]);
process.exit(Object.values(checks).some((v) => !v) || logs.length ? 1 : 0);
