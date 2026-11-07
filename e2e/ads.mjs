// Milestone A: the advertising economy, in real browsers.
// Asha (browser A) claims a stall, then a hoarding slot; uploads an image, writes brand/headline/
// description, points the ad at her stall, previews it on the 3D hoarding and submits it. She
// can't approve her own ad. A moderator (browser C, moderate.html) approves it; Ravi (browser B)
// sees it appear WITHOUT refreshing, clicks it with the mouse, opens Asha's listing; Asha sees
// genuine impressions/clicks. A rejected ad never appears; a takedown clears it for everyone live.
//   MOD_KEY=<moderator key> node e2e/ads.mjs http://localhost:5182/
import { launch, enter, BASE } from "./lib.mjs";

const MOD_KEY = process.env.MOD_KEY;
if (!MOD_KEY) throw new Error("Set MOD_KEY to the server's MODERATOR_KEY.");
const IMAGE = new URL("../docs/screens/coin-card.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const shots = process.env.SHOTS;
const base = BASE.replace(/\/$/, "");
const checks = {};
const ok = (name, v) => (checks[name] = !!v);
const waitFn = (page, fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const shot = (page, n) => shots && page.screenshot({ path: `${shots}/ads-${n}.png` }).catch(() => {});
const stand = (page, expr) => page.evaluate(`(() => { const o = window.__omen; ${expr} })()`);
const atBoard = (page, i) => stand(page, `const b = o.community.boards[${i}]; o.stand(b.front(), b.center())`);
const mine = (page) => page.evaluate(async () => (await (await fetch("/api/ads/mine", { headers: { "x-omen-token": localStorage.getItem("omen.identity") } })).json()).ads);

const [bA, bB, bC] = await Promise.all([launch(), launch(), launch()]);
const A = await enter(bA, BASE, { name: "Asha" });
const B = await enter(bB, BASE, { name: "Ravi" });
for (const P of [A.page, B.page]) {
  P.setDefaultTimeout(30000);
  await P.evaluate(() => {
    window.__toasts = [];
    new MutationObserver(() => window.__toasts.push(document.getElementById("toast").textContent)).observe(document.getElementById("toast"), { childList: true, characterData: true, subtree: true });
  });
}
const toasted = (page, re, ms = 15000) => waitFn(page, (s) => window.__toasts.some((t) => new RegExp(s).test(t)), re.source, ms);

// ------------------------------------------------------------ 1. Asha runs a stall (the ad's destination)
await stand(A.page, `o.stand(o.stalls["plot-lantern"].front(), o.stalls["plot-lantern"].group.position)`);
await A.page.waitForTimeout(700);
await A.page.keyboard.press("e");
await A.page.waitForSelector("#claim-f");
await A.page.fill("#claim-f [name=name]", "Asha's Chai Cart");
await A.page.click("#claim-f button.btn");
await A.page.waitForSelector("#prod-f");
await A.page.fill("#prod-f [name=name]", "Masala chai");
await A.page.fill("#prod-f [name=price]", "60");
await A.page.click("#prod-f button");
await waitFn(A.page, () => /Masala chai/.test(document.querySelector("#shop .catalog")?.textContent || ""));
await A.page.keyboard.press("Escape");

// ------------------------------------------------------------ 2. she claims a slot, writes the ad, previews it in 3D
await atBoard(A.page, 0);
await A.page.waitForTimeout(700);
const prompt = await A.page.textContent("#prompt-text");
await A.page.keyboard.press("e");
await A.page.waitForSelector("#ad-f");
const slotsBefore = await A.page.textContent("[data-slots]");
await A.page.setInputFiles("#ad-f [name=file]", IMAGE);
await A.page.fill("#ad-f [name=brand]", "Asha's Chai");
await A.page.fill("#ad-f [name=title]", "Masala chai, made to order");
await A.page.fill("#ad-f [name=text]", "Cardamom, ginger and a little jaggery. Find us at the Lantern stall, open all day.");
const destDefault = await A.page.isChecked("#ad-f [name=dest][value=shop]");
const linkDisabled = await A.page.isDisabled("#ad-f [name=link]");
await A.page.waitForTimeout(600);
await A.page.click("[data-preview3d]");
const previewLocal = await waitFn(A.page, () => !!window.__omen.community.boards[0].preview && document.getElementById("forum").hidden);
await A.page.waitForTimeout(500);
await shot(A.page, "1-preview-on-hoarding");
const othersSeeNothing = await B.page.evaluate(() => window.__omen.community.boards[0].preview === null && window.__omen.community.boards[0].shown === null);
ok("1 Asha claims a free slot and previews her ad on the real 3D hoarding (only she sees the preview)", /Advertise on the Plaza hoarding/.test(prompt) && /2 of 2 ad slots free/.test(slotsBefore) && destDefault && linkDisabled && previewLocal && othersSeeNothing);

// back to the form: the draft survives the preview round-trip
await A.page.keyboard.press("e");
await A.page.waitForSelector("#ad-f");
const draftKept = (await A.page.inputValue("#ad-f [name=brand]")) === "Asha's Chai" && (await A.page.inputValue("#ad-f [name=title]")) === "Masala chai, made to order";
const previewEnded = await A.page.evaluate(() => window.__omen.community.boards[0].preview === null);
await shot(A.page, "2-ad-form");
await A.page.click("#ad-f [data-submit]");
await A.page.waitForSelector("#forum .ok").catch(async (e) => {
  console.log("DIAGNOSTIC submit:", await A.page.evaluate(() => { const f = document.querySelector("#ad-f"); return JSON.stringify({ vals: Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, typeof v === "string" ? v : "file"])), valid: f.checkValidity(), bad: [...f.elements].filter((e) => e.validity && !e.validity.valid).map((e) => e.name + ":" + e.validationMessage), btn: f.querySelector("[data-submit]")?.disabled, err: document.querySelector("#forum .err")?.textContent }); }), "| logs:", JSON.stringify(A.logs).slice(0, 600));
  throw e;
});
const pendingList = await A.page.textContent(".campaigns");
ok("2 the draft survives the preview; submitting shows the campaign as waiting for review", draftKept && previewEnded && /Waiting for moderator review/.test(pendingList));
await A.page.keyboard.press("Escape");
await B.page.waitForTimeout(1500);
ok("3 nothing appears for other players before moderation", await B.page.evaluate(() => window.__omen.community.boards[0].shown === null));

// ------------------------------------------------------------ 3. moderation is a separate role
const ashaToken = await A.page.evaluate(() => localStorage.getItem("omen.identity"));
const q0 = await (await fetch(`${base}/api/mod/queue`, { headers: { "x-mod-key": MOD_KEY } })).json();
const pending = q0.pendingAds.find((a) => a.brand === "Asha's Chai");
const noKey = await fetch(`${base}/api/mod`, { method: "POST", headers: { "content-type": "application/json", "x-omen-token": ashaToken }, body: JSON.stringify({ action: "approve", id: pending.id }) });
const self = await fetch(`${base}/api/mod`, { method: "POST", headers: { "content-type": "application/json", "x-mod-key": MOD_KEY, "x-omen-token": ashaToken }, body: JSON.stringify({ action: "approve", id: pending.id }) });
ok("4 players can't approve ads, and a moderator can't approve their own", noKey.status === 403 && self.status === 403 && (await self.json()).error === "own_ad" && pending.shop?.name === "Asha's Chai Cart" && pending.image);

// the moderator console, in its own browser
const C = await (await bC.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
C.on("dialog", (d) => d.accept(d.message().startsWith("Why take") ? "Misleading claims" : "Not what we sell here"));
await C.goto(`${base}/moderate.html`);
await C.fill("#key", MOD_KEY);
await C.click("#unlock button");
await C.waitForSelector(`[data-pending="${pending.id}"]`);
const modCard = await C.textContent(`[data-pending="${pending.id}"]`);
await shot(C, "3-moderator-queue");
await C.click(`[data-pending="${pending.id}"] [data-act=approve]`);

// ------------------------------------------------------------ 4. live for everyone, no refresh
const liveForRavi = await waitFn(B.page, () => window.__omen.community.boards[0].shown?.brand === "Asha's Chai");
const ashaTold = await toasted(A.page, /is live on the Plaza hoarding/);
ok("5 the moderator approves in the console; Ravi sees it appear live without refreshing; Asha is told", /opens stall “Asha's Chai Cart”/.test(modCard) && /2\/2 slots free/.test(modCard) && liveForRavi && ashaTold);

// Ravi walks up: the hoarding is on his screen, facing him → one genuine impression
await atBoard(B.page, 0);
await B.page.waitForTimeout(1200);
await shot(B.page, "4-live-for-ravi");
const counted = await waitFn(A.page, async () => {
  const r = await fetch("/api/ads/mine", { headers: { "x-omen-token": localStorage.getItem("omen.identity") } });
  return (await r.json()).ads[0].stats.impressions >= 1;
}, null, 15000);

// he clicks the hoarding with the mouse → details → visits Asha's listing
await B.page.evaluate(() => (document.activeElement?.blur?.(), true));
const pt = await B.page.evaluate(() => {
  const o = window.__omen;
  const b = o.community.boards[0];
  const p = b.group.localToWorld(new o.THREE.Vector3(1.2, 3.6, 0.1)).project(o.camera);
  return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight };
});
await B.page.mouse.click(pt.x, pt.y);
await B.page.waitForSelector("#forum .ad-card");
const card = await B.page.textContent("#forum .ad-card");
await shot(B.page, "5-ad-details");
await B.page.click("[data-visit]");
await B.page.waitForSelector("#shop .catalog");
const listing = await B.page.textContent("#shop");
ok("6 Ravi clicks the 3D ad, reads the details and opens Asha's marketplace listing", counted && /Asha's Chai/.test(card) && /Cardamom, ginger/.test(card) && /Masala chai/.test(listing) && /Asha's Chai Cart/.test(listing));
await B.page.keyboard.press("Escape");

// Asha's own views don't count; her campaign shows the real numbers
await atBoard(A.page, 0);
await A.page.waitForTimeout(2500);
await waitFn(A.page, async () => {
  const r = await fetch("/api/ads/mine", { headers: { "x-omen-token": localStorage.getItem("omen.identity") } });
  return (await r.json()).ads[0].stats.clicks >= 2;
}, null, 10000);
const st = (await mine(A.page))[0].stats;
await A.page.keyboard.press("e");
await A.page.waitForSelector(".campaigns [data-stats]");
const statsText = await A.page.textContent(".campaigns");
await shot(A.page, "6-campaign-stats");
await A.page.keyboard.press("Escape");
ok("7 genuine stats: 1 impression from Ravi (not Asha), 2 clicks (details + listing), shown in her campaign", st.impressions === 1 && st.uniqueViewers === 1 && st.clicks === 2 && st.uniqueClickers === 1 && /LIVE/.test(statsText) && /1<\/b> impressions|1 impressions/.test(statsText.replace(/\s+/g, " ")));

// ------------------------------------------------------------ 5. a rejected ad never appears
await atBoard(B.page, 1);
await B.page.waitForTimeout(700);
await B.page.keyboard.press("e");
await B.page.waitForSelector("#ad-f");
await B.page.fill("#ad-f [name=brand]", "Ravi's Rides");
await B.page.fill("#ad-f [name=title]", "Cheap scooter rentals");
await B.page.click("#ad-f [data-submit]");
await B.page.waitForSelector("#forum .ok");
await B.page.keyboard.press("Escape");
await C.waitForSelector(`[data-pending] [data-act=reject]`);
await C.click(`[data-pending] [data-act=reject]`);
const raviTold = await toasted(B.page, /wasn't approved: Not what we sell here/);
await A.page.waitForTimeout(1200);
const neverShown = await A.page.evaluate(() => window.__omen.community.boards[1].shown === null);
const raviStatus = (await mine(B.page))[0];
ok("8 a rejected ad never appears; the advertiser sees the reason", raviTold && neverShown && raviStatus.status === "rejected" && raviStatus.reason === "Not what we sell here");

// ------------------------------------------------------------ 6. it survives a reload; a takedown clears it live
await B.page.reload();
await B.page.waitForSelector("#join:not([hidden])", { timeout: 120000 });
await B.page.click("#join");
await B.page.waitForSelector("#creator:not([hidden]) #mp-name");
await B.page.click("#start");
await B.page.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
const afterReload = await waitFn(B.page, () => window.__omen.community?.boards[0].shown?.brand === "Asha's Chai", null, 60000);
await C.waitForSelector("[data-live] [data-act=takedown]");
await shot(C, "7-moderator-live");
await C.click("[data-live] [data-act=takedown]");
const clearedLive = await waitFn(B.page, () => window.__omen.community.boards[0].shown === null);
const ashaTakedown = await toasted(A.page, /took down/);
ok("9 the ad survives Ravi's reload; a moderator takedown clears it for everyone live and tells Asha", afterReload && clearedLive && ashaTakedown && (await mine(A.page))[0].status === "removed");

const logs = [...A.logs, ...B.logs];
for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await Promise.all([bA.close(), bB.close(), bC.close()]);
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length || logs.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
process.exit(failed.length || logs.length ? 1 : 0);
