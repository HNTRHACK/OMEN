// Final Block steps 3–4: after the tutorial the countdown starts; KAI falls into Mumbai; the four
// booths are there; a booth opens with the testnet label on it.
//   E2E_GPU=1 SHOTS=dir node e2e/final-mumbai.mjs "http://localhost:5190/?mumbai=4"
import { launch, enter } from "./lib.mjs";

const shots = process.env.SHOTS;
const checks = {};
const ok = (k, v) => (checks[k] = !!v);
const browser = await launch();
const { page, logs } = await enter(browser);
await page.evaluate(() => {
  const o = window.__omen;
  o.state.stage = "deliver";
  o.state.relay = true;
});
// finish the chapter the normal way (Maya → lesson → Echo stage), which starts the countdown
await page.evaluate(() => window.__omen.talkables.find((t) => t.label === "Talk to Maya").run());
for (let i = 0; i < 60 && (await page.evaluate(() => window.__omen.state.stage)) !== "echo"; i++) {
  const c = await page.$("#dlg-choices .choice");
  if (c) await c.click();
  else await page.click(".dlg-panel").catch(() => {});
  await page.waitForTimeout(250);
}
for (let i = 0; i < 10 && (await page.isVisible("#dialogue")); i++) {
  await page.click(".dlg-panel").catch(() => {});
  await page.waitForTimeout(200);
}
const counting = await page.isVisible("#mumbai-countdown");
ok("1 after the tutorial a countdown to Mumbai appears", counting && /Mumbai opens in/.test(await page.textContent("#mumbai-countdown")));
if (shots) await page.screenshot({ path: `${shots}/5-countdown.png` });
await page.waitForFunction(() => window.__omen.mode === "fall", null, { timeout: 30000 });
await page.waitForTimeout(1500);
if (shots) await page.screenshot({ path: `${shots}/6-falling.png` });
await page.waitForFunction(() => window.__omen.mode === "play" && window.__omen.mumbai.active, null, { timeout: 30000 });
await page.waitForTimeout(800);
if (shots) await page.screenshot({ path: `${shots}/7-mumbai-arrival.png` });
const booths = await page.evaluate(() => window.__omen.talkables.map((t) => t.label));
ok("2 the fall lands in Mumbai with exactly the 4 booths to talk to", booths.length === 4 && booths.every((l) => /predict \(testnet\)/.test(l)));
// walk-up equivalent: open the Finalist Booth and look at it
await page.evaluate(() => window.__omen.talkables[0].run());
await page.waitForSelector("#booth .booth-card h2");
await page.waitForTimeout(500);
const boothText = await page.textContent("#booth");
if (shots) await page.screenshot({ path: `${shots}/8-booth.png` });
ok("3 a booth opens, shows its questions and says 'Testnet tokens only. No real money. Just for fun.'", /Finalist Booth/.test(boothText) && /Testnet tokens only\. No real money\. Just for fun\./.test(boothText) && /top 3 finalists/.test(boothText));
ok("4 an unverified player can't stake", /Only World ID-verified humans can predict/.test(boothText) && !(await page.$("#booth .booth-stake")));
await page.click(".booth-x");
await page.evaluate(() => window.__omen.talkables[3].run());
await page.waitForSelector("#booth .booth-signal");
const wall = await page.textContent("#booth");
if (shots) await page.screenshot({ path: `${shots}/9-problem-wall.png` });
ok("5 the problem-statement wall is a fun signal only and says no sponsor rewards anyone", /fun signal only/.test(wall) && /no sponsor rewards anyone/.test(wall));
for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await browser.close();
process.exit(Object.values(checks).some((v) => !v) || logs.length ? 1 : 0);
