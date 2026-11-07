// Final Block step 1: the human gate is the first screen; nothing claims "verified" unless the
// server says so; the dev-only unverified path is labelled; the title follows the gate.
//   E2E_GPU=1 SHOTS=dir node e2e/final-gate.mjs http://localhost:5190/
import { launch, BASE } from "./lib.mjs";

const shots = process.env.SHOTS;
const checks = {};
const ok = (k, v) => (checks[k] = !!v);
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
const page = await ctx.newPage();
const logs = [];
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && logs.push("console: " + m.text()));

await page.goto(BASE);
await page.waitForSelector("#gate:not([hidden]) #gate-go", { timeout: 120000 });
const text = await page.textContent("#gate");
if (shots) await page.screenshot({ path: `${shots}/1-gate.png` });
ok("1 the first screen is 'Only humans play OMEN', before the title", /Only humans play OMEN/.test(text) && (await page.isHidden("#title")));
const cfg = await page.evaluate(() => fetch("/api/world/config").then((r) => r.json()));
if (cfg.configured) {
  // real World ID: the server signs the request, IDKit opens a session with World's bridge
  await page.click("#gate-go");
  await page.waitForSelector(".gate-qr canvas", { timeout: 30000 });
  const link = await page.getAttribute("#gate-body a.btn", "href");
  if (shots) await page.screenshot({ path: `${shots}/1b-gate-worldid-qr.png` });
  ok("2 configured: Verify asks the server to sign, then shows a real World ID QR + World App link; nothing says VERIFIED", /^https:\/\//.test(link || "") && !/VERIFIED HUMAN/.test(await page.textContent("#gate")));
  console.log("connector host:", new URL(link).host);
  await page.click("#gate-cancel");
  await page.waitForSelector("#gate-go", { timeout: 10000 });
} else ok("2 without World ID credentials the verify button is disabled and says why; nothing says VERIFIED", (await page.isDisabled("#gate-go")) && /configured|missing/.test(text) && !/VERIFIED HUMAN/.test(text));
ok("3 the testnet label is on the screen", /Testnet tokens only\. No real money\. Just for fun\./.test(text));
const me = await page.evaluate(() => fetch("/api/human").then((r) => r.json()));
ok("4 the server has no human for this browser", me.human === null);
await page.click("#gate-guest");
await page.waitForSelector("#title:not([hidden]) #join");
ok("5 the dev-only UNVERIFIED path leads to the title", await page.isVisible("#join"));
if (shots) await page.screenshot({ path: `${shots}/2-title-after-gate.png` });

for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("LOGS", logs.length ? logs : "none");
await browser.close();
const failed = Object.values(checks).filter((v) => !v).length;
process.exit(failed || logs.length ? 1 : 0);
