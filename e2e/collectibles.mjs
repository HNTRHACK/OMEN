// Crypto discoveries: same coins for everyone in a room, live data on the card, nothing credited.
// Usage: node e2e/collectibles.mjs http://localhost:5173/
import { launch, enter, finish, BASE } from "./lib.mjs";

const ROOM = `coins-${Date.now().toString(36)}`;
const url = `${BASE.replace(/\/$/, "")}/?room=${ROOM}`;
const [bA, bB] = await Promise.all([launch(), launch()]);
const A = await enter(bA, url, { name: "Asha" });
const B = await enter(bB, url, { name: "Ravi" });
const shots = process.env.SHOTS;
const spots = (page) => page.evaluate(() => window.__omen.coins.items.map((it) => [it.def.sym, it.group.position.toArray().map((x) => +x.toFixed(3))]));
const sA = await spots(A.page);
const sB = await spots(B.page);
const sameCoins = sA.length === 6 && JSON.stringify(sA) === JSON.stringify(sB);
console.log("COINS", sA.map(([s, p]) => `${s}@${p.join(",")}`).join(" | "), "| same for both:", sameCoins);

// Ravi records every feed line from now on (lines fade after ~6 s, and CoinGecko can be slow)
await B.page.evaluate(() => {
  window.__feedSeen = [];
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__feedSeen.push(n.textContent)))).observe(document.getElementById("feed"), { childList: true });
});

// Asha walks to Bitcoin and presses E
const demoBefore = await A.page.evaluate(() => localStorage.getItem("omen.demo.v1"));
await A.page.evaluate(() => {
  const o = window.__omen;
  const it = o.coins.items.find((i) => i.def.sym === "btc");
  o.stand(o.coins.groundAt(it).add(o.coins.groundAt(it).clone().normalize().cross(new o.camera.position.constructor(0, 1, 0)).normalize().multiplyScalar(1.4)), it.group.position);
});
await A.page.waitForTimeout(700);
const prompt = await A.page.textContent("#prompt-text");
await A.page.keyboard.press("e");
await A.page.waitForSelector("#coin-card:not([hidden]) :is(.cc-price, .cc-err)", { timeout: 45000 });
if (await A.page.$("#coin-card .cc-err")) console.log("NOTE: CoinGecko was unreachable and no cached data existed; the card showed its honest 'unavailable' message, so live-data fields fail below.");
await A.page.waitForTimeout(600);
const card = (await A.page.textContent("#coin-card .cc-body")).replace(/\s+/g, " ").trim();
console.log("PROMPT", prompt);
console.log("CARD", card.slice(0, 700));
if (shots) await A.page.screenshot({ path: `${shots}/coin-card-btc.png`, timeout: 90000 }).catch(() => console.log("(screenshot skipped: renderer too busy)"));
const has = (re) => re.test(card);
const fields = {
  nameTicker: has(/Bitcoin BTC/),
  inr: has(/₹[\d,]+/),
  usd: has(/\$[\d,]+/),
  change24h: has(/[▲▼] \d+\.\d{2}% 24 h/),
  chart: (await A.page.$("#coin-card svg.cc-chart path.line")) !== null,
  launch: has(/3 Jan 2009.*Genesis block mined/),
  ath: has(/All-time high\s*₹[\d,]+\s*\$[\d,.]+ · \d{1,2} \w{3} \d{4}/),
  atl: has(/All-time low\s*₹[\d,]+\s*\$[\d,.]+ · \d{1,2} \w{3} \d{4}/),
  updated: has(/Price updated .* \(CoinGecko\) · fetched by OMEN/),
  educationalNote: has(/adds nothing to any wallet/),
};
console.log("FIELDS", JSON.stringify(fields));

// the other courier hears about it; nothing credited anywhere
const seen = await B.page.waitForFunction(() => window.__feedSeen.some((t) => /Asha found Bitcoin/.test(t)), null, { timeout: 15000 }).then(() => true, () => false);
const demoAfter = await A.page.evaluate(() => localStorage.getItem("omen.demo.v1"));
const nothingCredited = demoBefore === demoAfter;

// Escape closes it and the keyboard goes back to walking
await A.page.keyboard.press("Escape");
await A.page.waitForTimeout(300);
const closed = await A.page.isHidden("#coin-card");
const p0 = await A.page.evaluate(() => window.__omen.kai.group.position.toArray());
await A.page.keyboard.down("s");
await A.page.waitForTimeout(900);
await A.page.keyboard.up("s");
const p1 = await A.page.evaluate(() => window.__omen.kai.group.position.toArray());
const walksAfter = Math.hypot(...p1.map((x, i) => x - p0[i])) > 0.4;
const counted = await A.page.evaluate(() => JSON.parse(localStorage.getItem(`omen.coins.${window.__omen.coins.seed}`)));

// a different room code gives a different layout (same generator the game uses)
const otherRoomDiffers = await B.page.evaluate((sA) => JSON.stringify(window.__omen.coins.place("another-room").map((it) => [it.def.sym, it.group.position.toArray().map((x) => +x.toFixed(3))])) !== JSON.stringify(sA), sA);

const logs = [...A.logs, ...B.logs];
console.log("LOGS", logs.join("\n") || "none");
await bA.close();
await bB.close();
finish({ sameCoins, otherRoomDiffers, promptShown: /Discover Bitcoin/.test(prompt), ...fields, otherPlayerSawIt: seen, nothingCredited, closesWithEscape: closed, walksAfter, discoveryRemembered: counted.includes("btc"), noPageErrors: logs.length === 0 });
