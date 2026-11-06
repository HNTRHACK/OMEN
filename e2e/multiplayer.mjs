// Two independent browsers (separate processes and profiles) join one room via the invite URL.
// Usage: node e2e/multiplayer.mjs http://localhost:5173/
import { launch, enter, finish, BASE } from "./lib.mjs";

const ROOM = `e2e-${Date.now().toString(36)}`;
const url = `${BASE.replace(/\/$/, "")}/?room=${ROOM}`;
const [bA, bB] = await Promise.all([launch(), launch()]);
const A = await enter(bA, url, { name: "Asha" });
const B = await enter(bB, url, { name: "Ravi", outfit: 1 });
const shots = process.env.SHOTS;
const remotesOf = (page) =>
  page.evaluate(() => [...window.__omen.net.remotes.values()].map((r) => ({ id: r.id, name: r.name, visible: r.c.group.visible, pos: r.c.group.position.toArray(), tag: r.tag.textContent, tagShown: !r.tag.hidden })));
const waitFor = async (page, fn, arg, ms = 15000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

// 1. both see each other
const seeEachOther = (await waitFor(A.page, () => [...window.__omen.net.remotes.values()].some((r) => r.name === "Ravi" && r.c.group.visible))) && (await waitFor(B.page, () => [...window.__omen.net.remotes.values()].some((r) => r.name === "Asha" && r.c.group.visible)));
console.log("SEE EACH OTHER", seeEachOther, JSON.stringify((await remotesOf(A.page)).map(({ name, tag }) => ({ name, tag }))));
const feedA = () => A.page.evaluate(() => [...document.querySelectorAll("#feed li")].map((l) => l.textContent));
console.log("A feed after join:", JSON.stringify(await feedA()));
const joinedNotice = (await feedA()).some((t) => /Ravi joined/.test(t));
// Ravi chose the Brick outfit: Asha must see his jacket in brick (#b85c4a), not her own teal
const ravisJacket = await A.page.evaluate(() => {
  let hex = null;
  [...window.__omen.net.remotes.values()][0].c.rig.traverse((m) => m.isMesh && m.material.name === "teal" && (hex = m.material.color.getHexString()));
  return hex;
});
const ashasJacket = await A.page.evaluate(() => {
  let hex = null;
  window.__omen.kai.rig.traverse((m) => m.isMesh && m.material.name === "teal" && (hex = m.material.color.getHexString()));
  return hex;
});
console.log(`OUTFITS: Asha sees Ravi's jacket #${ravisJacket}; her own #${ashasJacket}`);

// 2. B walks; A sees B's character move (interpolated)
await B.page.evaluate(() => window.__omen.teleport(2, 6, 2, 12));
await B.page.waitForTimeout(800);
const p0 = (await remotesOf(A.page)).find((r) => r.name === "Ravi").pos;
await B.page.keyboard.down("w");
await B.page.waitForTimeout(1500);
await B.page.keyboard.up("w");
await A.page.waitForTimeout(800);
const p1 = (await remotesOf(A.page)).find((r) => r.name === "Ravi").pos;
const bTrue = await B.page.evaluate(() => window.__omen.kai.group.position.toArray());
const movedOnA = Math.hypot(...p1.map((x, i) => x - p0[i]));
const syncErr = Math.hypot(...p1.map((x, i) => x - bTrue[i]));
console.log(`MOVEMENT SYNC: Ravi moved ${movedOnA.toFixed(2)} m on Asha's screen; settled error vs Ravi's own ${syncErr.toFixed(3)} m`);

// put both near Maya for a screenshot where they can see each other
await A.page.evaluate(() => window.__omen.teleport(10.5, -4.6, 15.5, -10));
await B.page.evaluate(() => window.__omen.teleport(11.6, -6.4, 15.5, -10));
await A.page.waitForTimeout(1500);
if (shots) await A.page.screenshot({ path: `${shots}/mp-asha-sees-ravi.png` });

// 3. interactions show up for the other player
await B.page.evaluate(() => {
  const o = window.__omen;
  o.stand(o.signs["maya-chai"].front(), o.signs["maya-chai"].at);
});
await B.page.waitForTimeout(400);
await B.page.keyboard.press("e"); // scan Maya's QR
const scanSeen = await waitFor(A.page, () => [...document.querySelectorAll("#feed li")].some((l) => /Ravi is scanning Maya's QR/.test(l.textContent)));
// B pays with DEMO credits; A must see "Ravi paid Maya" and never the amount
for (let i = 0; i < 3; i++) await B.page.click("[data-act=next]").catch(() => {});
await B.page.waitForSelector("#q-f");
await B.page.click("#q-f button[type=submit]");
await B.page.waitForSelector("[data-act=approve]", { timeout: 20000 });
await B.page.click("[data-act=approve]");
await B.page.waitForSelector(".receipt", { timeout: 30000 });
const paidSeen = await waitFor(A.page, () => [...document.querySelectorAll("#feed li")].some((l) => /Ravi paid Maya/.test(l.textContent)));
const leaked = (await feedA()).some((t) => /₹|DEMO|0x|USDT|\d+\.\d{2}/.test(t));
console.log("FEED on Asha:", JSON.stringify(await feedA()), "| amount/address leaked:", leaked);
if (shots) await A.page.screenshot({ path: `${shots}/mp-asha-feed.png` });

// 4. B drops off the network and comes back: same player, no duplicate, no "left"
const idBefore = (await remotesOf(A.page)).find((r) => r.name === "Ravi").id;
await B.ctx.setOffline(true);
await B.page.evaluate(() => window.__omen.net && window.dispatchEvent(new Event("offline")));
await B.page.waitForTimeout(3000);
await B.ctx.setOffline(false);
const back = await waitFor(B.page, () => document.getElementById("mp-pill").classList.contains("on"), null, 20000);
await A.page.waitForTimeout(1500);
const after = (await remotesOf(A.page)).filter((r) => r.name === "Ravi");
const resumed = back && after.length === 1 && after[0].id === idBefore && !(await feedA()).some((t) => /Ravi left/.test(t));
console.log(`RECONNECT: back=${back} ravis=${after.length} sameId=${after[0]?.id === idBefore}`);

// 5. B closes the browser: A is told after the grace period
await bB.close();
const leftSeen = await waitFor(A.page, () => [...document.querySelectorAll("#feed li")].some((l) => /Ravi left/.test(l.textContent)) && ![...window.__omen.net.remotes.values()].some((r) => r.name === "Ravi"), null, 20000);
console.log("LEAVE NOTICE", leftSeen);
const logs = [...A.logs, ...B.logs];
console.log("LOGS", logs.join("\n") || "none");
await bA.close();
finish({ seeEachOther, joinedNotice, outfitSynced: ravisJacket === "b85c4a" && ashasJacket === "3e8e8a", movementSynced: movedOnA > 0.8 && syncErr < 0.25, scanSeen, paidSeen, noPaymentDetailsLeaked: !leaked, resumed, leftSeen, noPageErrors: logs.length === 0 });
