// Selfie-to-avatar, in real browsers: consent, photo, crop, on-device MediaPipe landmarks, the
// mapped likeness, manual editing, save + reload, walking with the new face, how another player's
// browser renders it, World ID badge states, and the camera path (a fake camera fed a photo).
//
// Needs two consented or public-domain portrait photos (not in the repo):
//   PHOTO_A=a.jpg PHOTO_B=b.jpg [CAMERA_Y4M=a.y4m] E2E_GPU=1 SHOTS=dir node e2e/selfie.mjs http://localhost:5183/
// World ID endpoints are stubbed at the network layer with the backend's documented response shapes
// (server/CONTRACT-WORLD-ID.md); the real backend isn't required.
import { chromium } from "playwright-core";
import { BASE } from "./lib.mjs";

const { PHOTO_A, PHOTO_B, CAMERA_Y4M } = process.env;
if (!PHOTO_A || !PHOTO_B) throw new Error("Set PHOTO_A and PHOTO_B to two portrait photos.");
const shots = process.env.SHOTS;
const base = BASE.replace(/\/$/, "");
const checks = {};
const ok = (name, v) => (checks[name] = !!v);
const shot = (page, n) => shots && page.screenshot({ path: `${shots}/selfie-${n}.png` }).catch(() => {});
const logs = [];
const GPU = process.env.E2E_GPU ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const launch = (extra = []) => chromium.launch({ executablePath: process.env.CHROME_PATH, args: [...GPU, ...extra] });

/** A page with the World ID API stubbed to `who` ("guest" | "verified" | "sandbox" | "none"). */
async function open(browser, who = "guest", { posted = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const state = { who };
  await ctx.route("**/api/auth/me", (r) => {
    if (state.who === "none") return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found", message: "Not found" }) });
    if (state.who === "expired") return r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "session_expired", message: "Session expired" }) });
    const world = state.who !== "guest";
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ player: { accountId: world ? "acc-1" : null, avatarId: "a".repeat(24), authType: world ? "world-id" : "guest", verifiedHuman: state.who === "verified", verificationEnvironment: state.who === "sandbox" ? "sandbox" : world ? "production" : null, sessionExpiresAt: world ? Date.now() + 8 * 3600e3 : null } }) });
  });
  await ctx.route("**/api/auth/world/status", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ configured: true, environment: "production", provider: "world-id" }) }));
  await ctx.route("**/api/avatar", (r) => {
    if (r.request().method() === "POST") {
      const b = JSON.parse(r.request().postData());
      posted.push(b);
      return r.fulfill({ contentType: "application/json", body: JSON.stringify({ avatar: { id: "a".repeat(24), displayName: b.displayName, look: b.look, revision: b.revision + 1, verifiedHuman: state.who === "verified" } }) });
    }
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ avatar: { id: "a".repeat(24), displayName: "Ravi", look: { skin: 1, hair: 0 }, revision: 3, verifiedHuman: state.who === "verified" } }) });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/`);
  await page.waitForSelector("#join:not([hidden])", { timeout: 120000 });
  await page.click("#join");
  await page.waitForSelector("#creator:not([hidden]) #mp-name");
  await page.waitForTimeout(600);
  return { page, ctx, state };
}
const look = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__omen.courier.look)));
const headShape = (page) =>
  page.evaluate(() => {
    const h = window.__omen.kai.p.head;
    const skin = h.children.find((m) => m.material?.name === "skin");
    const ink = h.children.find((m) => m.material?.name === "ink");
    skin.geometry.computeBoundingBox();
    ink.geometry.computeBoundingBox();
    const r = (v) => +v.toFixed(3);
    return { scale: h.scale.toArray().map(r), skin: [r(skin.geometry.boundingBox.min.x), r(skin.geometry.boundingBox.min.y)], eyes: [r(ink.geometry.boundingBox.min.x), r(ink.geometry.boundingBox.max.x), r(ink.geometry.boundingBox.max.y - ink.geometry.boundingBox.min.y)], extras: h.getObjectByName("face-extras")?.children.length ?? 0 };
  });
/** Upload a photo through the real flow (consent → photo → crop → analyse → apply). */
async function fromPhoto(page, file, tag) {
  await page.click("#cr-photo");
  await page.waitForSelector("#selfie:not([hidden]) #sf-ok");
  const goDisabled = await page.isDisabled("#sf-go");
  await page.check("#sf-ok");
  await page.click("#sf-go");
  await page.setInputFiles("#sf-file", file);
  await page.waitForFunction(() => /Face found|No face|More than one|couldn't load/.test(document.querySelector("#sf-status")?.textContent || ""), null, { timeout: 90000 });
  const status = await page.textContent("#sf-status");
  await shot(page, `${tag}-crop`);
  await page.click("#sf-use");
  await page.waitForSelector("#sf-apply", { timeout: 60000 });
  const resultText = (await page.textContent("#selfie .sf-body")).replace(/\s+/g, " ");
  await shot(page, `${tag}-result`);
  const photoGone = await page.evaluate(() => [...document.querySelectorAll("#selfie canvas")].every((c) => c.width === 0) && !document.querySelector("#sf-crop"));
  await page.click("#sf-apply");
  await page.waitForTimeout(700);
  return { goDisabled, status, resultText, photoGone };
}
/** Frame the creator's turntable on the face for a close-up. */
async function faceShot(page, n) {
  await page.evaluate(() => {
    const o = window.__omen;
    o.kai.group.updateMatrixWorld(true);
  });
  await page.waitForTimeout(1500);
  await shot(page, n);
}

const bA = await launch();
// ------------------------------------------------------------ 1. photo A → likeness
const A = await open(bA, "guest");
const badgeGuest = await A.page.textContent("#cr-id");
const worldBtn = await A.page.isVisible("#cr-world");
const before = await headShape(A.page);
const r1 = await fromPhoto(A.page, PHOTO_A, "a");
const lookA = await look(A.page);
const shapeA = await headShape(A.page);
console.log("PHOTO A", JSON.stringify(lookA.face), "| skin", lookA.skin, "hair", lookA.hair, "| status:", r1.status.slice(0, 60));
await faceShot(A.page, "a-avatar");
ok("1 consent is required before analysis; photo A is analysed on-device and the photo is discarded", r1.goDisabled && /Face found/.test(r1.status) && /Measured from the photo/.test(r1.resultText) && /Not in the photo/.test(r1.resultText) && r1.photoGone);
ok("2 the likeness is applied to the real rig (head proportions, eyes, brows, mouth, ears); the cap comes off and photo A's long hair is suggested", lookA.face && JSON.stringify(shapeA) !== JSON.stringify(before) && shapeA.extras >= 3 && lookA.hat === 1 && lookA.face.hairStyle === 6 && lookA.hairStyle === 1);

// ------------------------------------------------------------ 2. a different face gives a different likeness
const B = await open(bA, "guest");
await fromPhoto(B.page, PHOTO_B, "b");
const lookB = await look(B.page);
console.log("PHOTO B", JSON.stringify(lookB.face), "| skin", lookB.skin, "hair", lookB.hair);
await faceShot(B.page, "b-avatar");
const differs = Object.keys(lookA.face).filter((k) => lookA.face[k] !== lookB.face[k]);
ok("3 two different photos produce different face settings (not a fixed preset); short hair isn't made long", differs.length >= 2 && lookB.face.hairStyle !== 6);
console.log("differs in:", differs.join(", "));

// ------------------------------------------------------------ 3. manual editing, regenerate, save + reload
await A.page.click('.cr-tabs [data-tab="face"]');
await A.page.click('[data-s="face"][data-k="jaw"][data-i="2"]'); // square jaw
await A.page.click('.cr-tabs [data-tab="hair"]');
await A.page.click('[data-s="face"][data-k="hairStyle"][data-i="2"]'); // curly top
await A.page.click('.cr-tabs [data-tab="extras"]');
await A.page.click('[data-s="face"][data-k="glasses"][data-i="2"]'); // rectangle glasses
const edited = await look(A.page);
const shapeEdited = await headShape(A.page);
await faceShot(A.page, "a-edited");
ok("4 manual edits (jaw, hairstyle, glasses) change the live 3D preview", edited.face.jaw === 2 && edited.face.hairStyle === 2 && edited.face.glasses === 2 && shapeEdited.extras > shapeA.extras);
await A.page.click("#cr-regen");
const regen = await look(A.page);
ok("5 Regenerate from selfie restores the photo's likeness", JSON.stringify(regen.face) === JSON.stringify(lookA.face));
await A.page.click('.cr-tabs [data-tab="extras"]');
await A.page.click('[data-s="face"][data-k="glasses"][data-i="1"]');
await A.page.fill("#mp-name", "Asha");
await A.page.click("#cr-save");
const saved = await look(A.page);
await A.page.reload();
await A.page.waitForSelector("#join:not([hidden])", { timeout: 120000 });
await A.page.click("#join");
await A.page.waitForSelector("#creator:not([hidden]) #mp-name");
await A.page.waitForTimeout(800);
const reloaded = await look(A.page);
const stored = await A.page.evaluate(() => localStorage.getItem("omen.courier"));
ok("6 Save keeps the avatar across a reload (only option indices are stored, no image data)", JSON.stringify(reloaded.face) === JSON.stringify(saved.face) && !/data:image|base64/.test(stored) && stored.length < 600);

// ------------------------------------------------------------ 4. walking and animating with the new face
await A.page.click("#start");
await A.page.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
for (let i = 0; i < 8 && (await A.page.isVisible("#dialogue")); i++) {
  await A.page.click(".dlg-panel");
  await A.page.waitForTimeout(250);
}
const p0 = await A.page.evaluate(() => window.__omen.kai.group.position.toArray());
await A.page.evaluate(() => {
  window.__maxSpeed = 0;
  const f = () => ((window.__maxSpeed = Math.max(window.__maxSpeed, window.__omen.kai.speed)), window.__omen.mode === "play" && requestAnimationFrame(f));
  requestAnimationFrame(f);
});
await A.page.keyboard.down("w");
await A.page.keyboard.down("Shift");
await A.page.waitForTimeout(1600);
const running = await A.page.evaluate(() => window.__maxSpeed);
await A.page.keyboard.up("Shift");
await A.page.keyboard.up("w");
await A.page.keyboard.press("Space");
await A.page.waitForTimeout(200);
const air = await A.page.evaluate(() => window.__omen.kai.air);
await A.page.waitForTimeout(900);
const p1 = await A.page.evaluate(() => window.__omen.kai.group.position.toArray());
const faceKept = await headShape(A.page);
await shot(A.page, "a-walking");
console.log("WALK", JSON.stringify({ moved: +Math.hypot(...p1.map((v, i) => v - p0[i])).toFixed(2), running: +running.toFixed(2), air, extras: faceKept.extras }));
ok("7 the customised courier walks, runs and jumps with the face intact", Math.hypot(...p1.map((v, i) => v - p0[i])) > 2 && running > 5 && air && faceKept.extras >= 3);

// ------------------------------------------------------------ 5. what another player's browser renders
const remote = await B.page.evaluate((lk) => {
  const o = window.__omen;
  const build = (look) => {
    const c = new o.Character("kai", { unique: true });
    o.applyLook(c, look);
    const h = c.p.head;
    const ink = h.children.find((m) => m.material?.name === "ink");
    ink.geometry.computeBoundingBox();
    return { scale: h.scale.toArray().map((v) => +v.toFixed(3)), extras: h.getObjectByName("face-extras")?.children.length ?? 0, eyeW: +(ink.geometry.boundingBox.max.x - ink.geometry.boundingBox.min.x).toFixed(3) };
  };
  const { face, ...baseLook } = lk;
  return { withFace: build(lk), serverToday: build(baseLook) };
}, saved);
console.log("REMOTE", JSON.stringify(remote));
ok("8 a second browser renders the same face from the same look; without the face (what the server forwards today) it falls back cleanly", remote.withFace.extras >= 3 && remote.serverToday.extras === 0 && remote.serverToday.scale.every((v) => v === 1));

// ------------------------------------------------------------ 6. World ID badge states (server-confirmed only)
const badges = {};
for (const who of ["guest", "sandbox", "verified", "expired", "none"]) {
  A.state.who = who;
  await A.page.evaluate(() => window.__omenAvatar.refreshIdentity());
  await A.page.waitForTimeout(300);
  badges[who] = await A.page.evaluate(() => document.querySelector("#cr-id")?.textContent || "");
}
console.log("BADGES", JSON.stringify(badges));
ok("9 'Verified human' appears only when the server says verifiedHuman; sandbox is labelled a test account; an expired session is never shown as guest or verified", /Verified human/.test(badges.verified) && !/Verified human/.test(badges.sandbox + badges.guest + badges.none + badges.expired) && /sandbox/.test(badges.sandbox) && /expired/.test(badges.expired) && !/Guest/.test(badges.expired) && /Guest/.test(badgeGuest) && worldBtn && /unavailable/.test(badges.none));

// a World ID account save sends only the backend's accepted fields (no face, no photo)
const posted = [];
const W = await open(bA, "verified", { posted });
await W.page.waitForFunction(() => /Verified human/.test(document.querySelector("#cr-id")?.textContent || ""), null, { timeout: 10000 });
await W.page.click('.cr-tabs [data-tab="face"]');
await W.page.click('[data-s="face"][data-k="nose"][data-i="3"]');
await W.page.click("#cr-save");
await W.page.waitForTimeout(600);
await shot(W.page, "verified-badge");
const body = posted[0] || {};
ok("10 saving a World ID avatar posts {displayName, look, revision} with base-look keys only; the face stays on the device", body.revision === 3 && body.look && !("face" in body.look) && Object.keys(body).every((k) => ["displayName", "look", "revision"].includes(k)));

// ------------------------------------------------------------ 7. camera: denied, then a fake camera showing photo A
const bDeny = await launch(["--deny-permission-prompts"]);
const C = await open(bDeny, "guest");
await C.page.click("#cr-selfie");
await C.page.check("#sf-ok");
await C.page.click("#sf-go");
await C.page.waitForFunction(() => /declined|No camera|couldn't start|secure/.test(document.querySelector("#sf-cam-msg")?.textContent || ""), null, { timeout: 15000 });
const denied = await C.page.textContent("#sf-cam-msg");
console.log("DENIED", denied.trim());
ok("11 a denied/missing camera is explained, with upload offered instead", /upload a photo instead/i.test(denied));
await bDeny.close();
let camOk = "skipped (no CAMERA_Y4M)";
if (CAMERA_Y4M) {
  const bC = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${CAMERA_Y4M}`]);
  const D = await open(bC, "guest");
  await D.ctx.grantPermissions(["camera"]);
  await D.page.click("#cr-selfie");
  await D.page.check("#sf-ok");
  await D.page.click("#sf-go");
  await D.page.waitForSelector("#sf-snap:not([disabled])", { timeout: 20000 });
  await D.page.waitForTimeout(800);
  await shot(D.page, "camera");
  await D.page.click("#sf-snap");
  await D.page.waitForFunction(() => /Face found|No face/.test(document.querySelector("#sf-status")?.textContent || ""), null, { timeout: 90000 });
  camOk = await D.page.textContent("#sf-status");
  await D.page.click("#sf-use");
  await D.page.waitForSelector("#sf-apply", { timeout: 60000 });
  await D.page.click("#sf-apply");
  const camLook = await look(D.page);
  console.log("CAMERA", camOk.slice(0, 40), JSON.stringify(camLook.face));
  ok("12 a selfie taken with the camera goes through the same pipeline", /Face found/.test(camOk) && camLook.face);
  await bC.close();
}

// ------------------------------------------------------------ 8. frame rate in the world with the face
const perf = await A.page.evaluate(async () => {
  const d = [];
  let last = performance.now();
  await new Promise((res) => {
    const t0 = last;
    const f = (t) => {
      d.push(t - last);
      last = t;
      if (t - t0 < 3000) requestAnimationFrame(f);
      else res();
    };
    requestAnimationFrame(f);
  });
  d.sort((a, b) => a - b);
  return { avgFps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p99: +d[Math.floor(d.length * 0.99)].toFixed(1) };
});
console.log("PERF", JSON.stringify(perf));

for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await bA.close();
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length || logs.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
process.exit(failed.length || logs.length ? 1 : 0);
