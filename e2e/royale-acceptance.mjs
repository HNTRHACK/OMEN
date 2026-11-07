// Bounty Royale acceptance: two independent browsers (laptop + phone), two verified humans, two
// distinct persistent avatars in one live world, one shared prediction arena, moderator settlement,
// realtime updates, and everything still there after a refresh.
//   (start e2e/royale-harness.mjs first) E2E_GPU=1 SHOTS=dir node e2e/royale-acceptance.mjs http://localhost:5195/
import { chromium, devices } from "playwright-core";
import { BASE, passGate } from "./lib.mjs";

const base = BASE.replace(/\/$/, "");
const shots = process.env.SHOTS;
const checks = {};
const ok = (k, v, extra = "") => ((checks[k] = !!v), !v && extra && console.log("  detail:", k, extra));
const logs = [];
const GPU = process.env.E2E_GPU ? ["--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const shot = (p, n) => shots && p.screenshot({ path: `${shots}/royale-${n}.png` }).catch(() => {});

async function player(label, device, name) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: GPU });
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1280, height: 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => logs.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon|WebSocket/i.test(m.text()) && logs.push(`${label} console: ${m.text()}`));
  await page.goto(base + "/");
  // the harness stubs only World's verify API; the server still runs the whole /api/verify path
  const nullifier = String(BigInt("0x" + crypto.randomUUID().replaceAll("-", "")));
  const v = await page.evaluate((nl) => fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result: { action: "play-omen", environment: "staging", responses: [{ identifier: "orb", nullifier: nl }] } }) }).then((r) => r.json()), nullifier);
  await page.reload();
  await passGate(page);
  return { browser, ctx, page, name, human: v.human };
}

async function enterWorld(p) {
  await p.page.waitForSelector("#join:not([hidden])", { timeout: 120000 });
  await p.page.click("#join");
  await p.page.waitForSelector("#creator:not([hidden]) #mp-name");
  await p.page.fill("#mp-name", p.name);
  await p.page.click("#start");
  await p.page.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
  for (let i = 0; i < 8 && (await p.page.isVisible("#dialogue")); i++) {
    await p.page.click(".dlg-panel").catch(() => {});
    await p.page.waitForTimeout(250);
  }
}

const A = await player("A", null, "Asha");
const B = await player("B", "Pixel 7", "Ravi");
ok("1 both players are verified humans (server sessions) with server-assigned avatars", A.human?.verified && B.human?.verified && A.human.look && B.human.look);
ok("2 the two randomized avatars differ", JSON.stringify(A.human.look) !== JSON.stringify(B.human.look), JSON.stringify([A.human.look, B.human.look]));

await enterWorld(A);
await enterWorld(B);
const sees = (p) => p.page.waitForFunction(() => window.__omen.net.remotes?.size >= 1, null, { timeout: 30000 }).then(() => true, () => false);
const [aSees, bSees] = await Promise.all([sees(A), sees(B)]);
const remoteLook = (p) => p.page.evaluate(() => [...window.__omen.net.remotes.values()].map((r) => ({ name: r.name ?? r.c?.name, look: r.look ?? r.c?.look })));
const aRemote = await remoteLook(A);
await shot(A.page, "1-A-world");
await shot(B.page, "1-B-world");
ok("3 each sees the other in the same live world", aSees && bSees, JSON.stringify(aRemote));
const myLook = (p) => p.page.evaluate(() => window.__omen.courier.look);
ok("4 each wears its server-assigned look", JSON.stringify(await myLook(A)).includes(JSON.stringify(A.human.look).slice(1, -1)) && JSON.stringify(await myLook(B)).includes(JSON.stringify(B.human.look).slice(1, -1)));

// ------------------------------------------------------------ moderator imports the teams (server-side auth)
const mod = async (path, body, cookie) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get("set-cookie")?.split(";")[0] };
};
const login = await mod("/api/mod/login", { username: "royale-mod", password: "harness-moderator-pass" });
const M = login.cookie;
const imp = await mod("/api/royale/mod/projects", { projects: [{ name: "Chai Chain", team: "Team Kettle" }, { name: "Dabba Pay", team: "Lunchbox" }, { name: "Pixel Bazaar", team: "8bit", isGame: true }, { name: "Local Train Lens" }] }, M);
const forged = await mod("/api/royale/mod/markets/top3/settle", { winners: ["chai-chain"], source: "x" });
ok("5 moderator imports teams; an unauthenticated settle is refused", imp.status === 200 && imp.body.imported === 4 && forged.status === 401);

// ------------------------------------------------------------ both enter Bounty Royale
async function openArena(p) {
  await p.page.click("#royale-hud");
  await p.page.waitForSelector("#royale .ra-card h2");
}
await openArena(A);
await openArena(B);
for (const p of [A, B]) {
  await p.page.click("[data-join]");
  await p.page.waitForSelector("[data-balance]");
}
const bal = (p) => p.page.textContent("[data-balance]");
ok("6 both get the one-time 1,000 points", (await bal(A)) === "1,000" && (await bal(B)) === "1,000");
await shot(A.page, "2-A-arena");

async function pick(p, tabId, marketId, selection, amount, sponsor) {
  await p.page.click(`[data-tab="${tabId}"]`);
  if (sponsor) await p.page.click(`[data-sponsor="${sponsor}"]`);
  await p.page.click(`[data-market="${marketId}"] [data-pick="${selection}"]`);
  await p.page.fill(".ra-confirm input[name=amount]", String(amount));
  await p.page.click(".ra-confirm button[type=submit]");
  await p.page.waitForSelector(".ra-flash");
  return p.page.textContent(".ra-flash");
}
// concurrently, different markets
const [fa, fb] = await Promise.all([pick(A, "top3", "top3", "chai-chain", 300), pick(B, "bounty", "bounty-whitechain", "dabba-pay", 200, "bounty-whitechain")]);
await shot(B.page, "3-B-picked");
ok("7 concurrent picks on different markets lock in and balances drop", /Locked/.test(fa) && /Locked/.test(fb) && (await bal(A)) === "700" && (await bal(B)) === "800", `${fa} | ${fb}`);
await pick(B, "top3", "top3", "pixel-bazaar", 100);
// realtime: A (no reload) sees B's activity and the top3 pool grow
const live = await A.page.waitForFunction(() => /Ravi<\/b> put 100 on Pixel Bazaar/.test(document.querySelector(".ra-activity")?.innerHTML || "") && /Pool <b>400<\/b>/.test(document.querySelector('[data-market="top3"]')?.innerHTML || ""), null, { timeout: 10000 }).then(() => true, () => false);
await shot(A.page, "4-A-live-activity");
ok("8 A sees B's pick and the shared pool update live (Socket.IO, no refresh)", live);
const dup = await B.page.evaluate(() => fetch("/api/royale/predictions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketId: "top3", selection: "pixel-bazaar", amount: 5, idempotencyKey: "dupdupdup-1" }) }).then((r) => r.status));
const cheat = await B.page.evaluate(() => fetch("/api/royale/predictions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketId: "game-wildcard", selection: "yes", amount: 5000, idempotencyKey: "cheatcheat-1" }) }).then((r) => r.status));
ok("9 duplicate picks and oversized stakes are refused by the server", dup === 409 && cheat === 400);

// ------------------------------------------------------------ moderator closes + settles top3
const closed = await mod("/api/royale/mod/markets/top3/close", {}, M);
const settled = await mod("/api/royale/mod/markets/top3/settle", { winners: ["chai-chain"], source: "harness: official announcement stand-in" }, M);
const [revA, revB] = await Promise.all([A, B].map((p) => p.page.waitForSelector(".ra-reveal", { timeout: 10000 }).then(() => p.page.textContent(".ra-reveal"), () => "")));
await shot(A.page, "5-A-reveal");
await shot(B.page, "5-B-reveal");
ok("10 moderator closes and settles; both see the synchronized reveal", closed.status === 200 && settled.status === 200 && /Chai Chain/.test(revA) && /Chai Chain/.test(revB));
ok("11 A scores the whole 400-point pool (+400 → 1,100); B's top-3 pick scores 0", /\+400/.test(revA) && !/scored/.test(revB));
for (const p of [A, B]) await p.page.click(".ra-reveal button").catch(() => {});
await A.page.click('[data-tab="board"]');
const board = await A.page.textContent(".ra-board");
await shot(A.page, "6-A-leaderboard");
ok("12 leaderboard: Asha 1,100 above Ravi 900 (700 + 200 still open)", /#1\s*Asha\s*1,100/.test(board.replace(/\s+/g, " ")) && /#2\s*Ravi\s*900/.test(board.replace(/\s+/g, " ")), board);

// ------------------------------------------------------------ refresh both: everything persists
const before = { a: await myLook(A), b: await myLook(B) };
for (const p of [A, B]) {
  await p.page.reload();
  await passGate(p.page);
  await p.page.waitForSelector("#title:not([hidden]) #royale-enter");
  await p.page.click("#royale-enter");
  await p.page.waitForSelector("[data-balance]");
}
const after = { a: await myLook(A), b: await myLook(B) };
await A.page.click('[data-tab="mine"]');
const histA = await A.page.textContent(".ra-hist");
ok("13 after refresh: identities, looks, balances, picks and results persist", JSON.stringify(before) === JSON.stringify(after) && (await bal(A)) === "1,100" && (await bal(B)) === "700" && /won \+400/.test(histA), JSON.stringify({ histA }));
await shot(B.page, "7-B-after-refresh");

for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await Promise.all([A.browser.close(), B.browser.close()]);
process.exit(Object.values(checks).some((v) => !v) || logs.length ? 1 : 0);
