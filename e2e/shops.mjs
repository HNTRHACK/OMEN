// Player-owned shop, two independent browsers: Asha claims a stall and lists a product; Ravi sees
// the sign change live, browses it and buys with DEMO credits; Asha's dashboard gets the PAID order
// in real time; stock drops; a refresh keeps the shop. (USDT version: e2e/final-fork.mjs.)
// Usage: node e2e/shops.mjs http://localhost:5173/
import { launch, enter, finish, BASE } from "./lib.mjs";

const [bA, bB] = await Promise.all([launch(), launch()]);
const A = await enter(bA, BASE, { name: "Asha", look: { jacket: 3, hat: 2 } });
const B = await enter(bB, BASE, { name: "Ravi", look: { jacket: 1, pet: 2 } });
const shots = process.env.SHOTS;
const plot = "plot-lantern";

// Asha walks to the vacant Lantern stall and claims it
await A.page.evaluate((id) => {
  const o = window.__omen;
  o.stand(o.stalls[id].front(), o.stalls[id].group.position);
}, plot);
await A.page.waitForTimeout(600);
const claimPrompt = await A.page.textContent("#prompt-text");
await A.page.keyboard.press("e");
await A.page.waitForSelector("#claim-f");
await A.page.fill("#claim-f [name=name]", "Asha's Spice Cart");
await A.page.fill("#claim-f [name=tagline]", "Cardamom, saffron, chai masala");
await A.page.click("#claim-f .sw-pick:nth-child(4)");
await A.page.click("#claim-f button.btn");
await A.page.waitForSelector("#prod-f");
await A.page.fill("#prod-f [name=name]", "Chai masala");
await A.page.fill("#prod-f [name=price]", "45");
await A.page.fill("#prod-f [name=stock]", "5");
await A.page.click("#prod-f button");
await A.page.waitForFunction(() => /Chai masala/.test(document.querySelector("#shop .catalog")?.textContent || ""));
await A.page.click("[data-dtab=orders]");
await A.page.waitForTimeout(300);

// Ravi's world updates by itself: the sign now names Asha's shop
const signLive = await B.page.waitForFunction((id) => window.__omen.stalls[id].shop?.name === "Asha's Spice Cart", plot, { timeout: 15000 }).then(() => true, () => false);
await B.page.evaluate((id) => {
  const o = window.__omen;
  o.stand(o.stalls[id].front(), o.stalls[id].group.position);
}, plot);
await B.page.waitForTimeout(800);
const browsePrompt = await B.page.textContent("#prompt-text");
if (shots) await B.page.screenshot({ path: `${shots}/shop-stall.png` }).catch(() => {});
await B.page.keyboard.press("e");
await B.page.waitForSelector("#shop .catalog [data-inc]");
await B.page.click("#shop .catalog [data-inc]");
await B.page.waitForFunction(() => document.querySelector("#shop .basket b")?.textContent === "₹45.00");
await B.page.click("#shop .catalog [data-inc]");
await B.page.waitForFunction(() => document.querySelector("#shop .basket b")?.textContent === "₹90.00", null, { timeout: 10000 }).catch(() => {});
const basket = await B.page.textContent("#shop .basket b");
if (shots) await B.page.screenshot({ path: `${shots}/shop-browse.png` }).catch(() => {});
await B.page.click("[data-pay=DEMO]");
await B.page.waitForSelector("#pay:not([hidden]) [data-act=approve]", { timeout: 30000 });
const quote = (await B.page.textContent("#pay .quote")).replace(/\s+/g, " ");
await B.page.click("[data-act=approve]");
await B.page.waitForSelector("#pay .receipt", { timeout: 30000 });
const receipt = (await B.page.textContent("#pay .receipt")).replace(/\s+/g, " ");

// Asha hears about it on her own screen, and her dashboard shows the PAID order
const notified = await A.page.waitForFunction(() => /New order PAID: 2× Chai masala from Ravi/.test(document.getElementById("toast").textContent), null, { timeout: 15000 }).then(() => true, () => false);
const dashShows = await A.page.waitForFunction(() => /2× Chai masala[\s\S]*from Ravi[\s\S]*PAID/.test(document.querySelector("#shop .hist")?.textContent || ""), null, { timeout: 15000 }).then(() => true, () => false);
if (shots) await A.page.screenshot({ path: `${shots}/shop-dashboard.png` }).catch(() => {});
await A.page.click("[data-fulfil]");
const fulfilled = await A.page.waitForFunction(() => /fulfilled \(simulated\)/.test(document.querySelector("#shop .hist")?.textContent || ""), null, { timeout: 10000 }).then(() => true, () => false);
const stockAfter = await A.page.evaluate(() => fetch("/api/shops").then((r) => r.json()).then((d) => d.plots.find((p) => p.plot === "plot-lantern").shop.products[0].stock));

// A refresh keeps everything (server-side persistence + stable identity)
await A.page.reload();
await A.page.waitForSelector("#continue:not([hidden])", { timeout: 120000 });
await A.page.click("#continue");
await A.page.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
await A.page.waitForTimeout(1500);
const stillMine = await A.page.evaluate(() => window.__omen.shops.mine?.name === "Asha's Spice Cart");

console.log(`PROMPTS: "${claimPrompt}" → "${browsePrompt}" | basket ${basket}`);
console.log("QUOTE", quote.slice(0, 160));
console.log("RECEIPT", receipt.slice(0, 220));
console.log(`stock 5 → ${stockAfter} | still Asha's after refresh: ${stillMine}`);
const logs = [...A.logs, ...B.logs];
console.log("LOGS", logs.join("\n") || "none");
await bA.close();
await bB.close();
finish({
  claimPrompt: claimPrompt === "Claim this stall",
  signUpdatedLiveForOthers: signLive,
  browsePrompt: browsePrompt === "Browse Asha's Spice Cart",
  basketTotal: basket === "₹90.00",
  quoted: /Merchant receives\s*₹90\.00/.test(quote),
  paid: /Paid|PAID/.test(receipt) || /₹90\.00/.test(receipt),
  sellerNotifiedLive: notified,
  dashboardShowsPaidOrder: dashShows,
  fulfilmentSimulated: fulfilled,
  stockDecremented: stockAfter === 3,
  shopSurvivesRefresh: stillMine,
  noPageErrors: logs.length === 0,
});
