// Final Block step 2: the delivery ends with the payment lesson (wallet, escrow, signature, gas).
// Unverified (dev guest) → it must run as a clearly labelled SIMULATION with no explorer link.
//   E2E_GPU=1 SHOTS=dir node e2e/final-tutorial.mjs http://localhost:5190/
import { launch, enter } from "./lib.mjs";

const shots = process.env.SHOTS;
const checks = {};
const ok = (k, v) => (checks[k] = !!v);
const browser = await launch();
const { page, logs } = await enter(browser);
// jump to the last beat of the chapter: KAI carries Orin's sealed findings back to Maya
await page.evaluate(() => {
  const o = window.__omen;
  o.state.stage = "deliver";
  o.state.relay = true;
  o.talkables.find((t) => t.label === "Talk to Maya").run();
});
const said = [];
for (let i = 0; i < 60; i++) {
  if (await page.isVisible("#chai-receipt")) break;
  if (await page.isVisible("#dialogue")) {
    const t = (await page.textContent("#dialogue")).replace(/\s+/g, " ").trim();
    if (said.at(-1) !== t) said.push(t);
    if (/SIMULATED/.test(t) && shots) await page.screenshot({ path: `${shots}/3-tutorial-simulated-line.png` });
    const choice = await page.$("#dlg-choices .choice");
    if (choice) await choice.click();
    else await page.click(".dlg-panel");
  }
  await page.waitForTimeout(300);
}
const all = said.join(" | ");
ok("1 the lesson teaches wallet, escrow and (when real) signature/gas", /WALLET/.test(all) && /ESCROW/.test(all) && /SIGNATURE/.test(all) && /GAS/.test(all));
ok("2 unverified → labelled SIMULATION, no transaction claimed", /SIMULATION/.test(all) && /no real transaction was sent/.test(all));
const chip = await page.$eval("#chai-receipt", (e) => ({ cls: e.className, text: e.textContent, link: !!e.querySelector("a") })).catch(() => null);
ok("3 the receipt chip says SIMULATED PAYMENT and has no explorer link", chip && chip.cls === "sim" && /SIMULATED PAYMENT/.test(chip.text) && !chip.link);
if (shots) await page.screenshot({ path: `${shots}/4-tutorial-receipt.png` });
for (let i = 0; i < 12 && (await page.isVisible("#dialogue")); i++) {
  await page.click(".dlg-panel").catch(() => {});
  await page.waitForTimeout(250);
}
ok("4 the chapter still finishes: stage moves on to Echo", (await page.evaluate(() => window.__omen.state.stage)) === "echo");
for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("DIALOGUE", said.filter((x, i, a) => !a[i + 1]?.startsWith(x)).slice(0, 14));
console.log("LOGS", logs.length ? logs : "none");
await browser.close();
process.exit(Object.values(checks).some((v) => !v) || logs.length ? 1 : 0);
