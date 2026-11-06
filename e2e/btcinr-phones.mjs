// Two-phone BTC→INR demo against the REAL backend (server/CONTRACT-BTCINR.md): two independent
// mobile browsers. Phone B signs up as a merchant and shows its QR; Phone A's camera (a fake
// camera fed Phone B's actual QR) scans it, quotes, confirms; Phone B is notified live and the
// receipts match. Balances are read back from the server, never assumed.
//   E2E_GPU=1 SHOTS=dir WORK=dir node e2e/btcinr-phones.mjs http://localhost:5184/
import { chromium, devices } from "playwright-core";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { BASE } from "./lib.mjs";

const shots = process.env.SHOTS;
const work = process.env.WORK || ".";
const base = BASE.replace(/\/$/, "");
const checks = {};
const ok = (name, v) => (checks[name] = !!v);
const logs = [];
const shot = (page, n) => shots && page.screenshot({ path: `${shots}/phone-${n}.png`, fullPage: false }).catch(() => {});
const GPU = process.env.E2E_GPU ? ["--ignore-gpu-blocklist"] : [];

async function phone(device, extra = []) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: [...GPU, ...extra] });
  const ctx = await browser.newContext({ ...devices[device], defaultBrowserType: undefined, ignoreHTTPSErrors: process.env.E2E_SELF_SIGNED === '1' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => logs.push(`${device} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon/i.test(m.text()) && logs.push(`${device} console: ${m.text()}`));
  return { browser, ctx, page };
}
/** What the server says this customer has (A's own guest identity, not a UI scrape). */
const customerSats = (page) => page.evaluate(async () => BigInt((await window.__pay.api.customer()).balance.btcSats).toString());
const merchantPaise = (page) => page.evaluate(async () => (await window.__pay.api.merchant()).balance.inrPaise);

// ------------------------------------------------------------ Phone B: the merchant
const B = await phone("Pixel 7");
await B.page.goto(`${base}/pay.html`);
await B.page.click(`[data-go="#/merchant"]`);
await B.page.waitForSelector("#up");
await shot(B.page, "B1-open-shop");
await B.page.fill("#up [name=b]", "Chai Point");
await B.page.fill("#up [name=n]", "Asha");
await B.page.click("#up button");
await B.page.waitForSelector("[data-access]");
const access = await B.page.textContent("[data-access]");
await shot(B.page, "B2-access-code");
await B.page.click("#cont");
await B.page.waitForSelector("#qr canvas");
await B.page.waitForFunction(() => document.querySelector("#conn")?.dataset.state === "live", null, { timeout: 15000 });
const b0 = await merchantPaise(B.page);
await shot(B.page, "B3-receiving-qr");
const qrPng = await B.page.evaluate(() => document.querySelector("#qr canvas").toDataURL("image/png"));
const qrCode = await B.page.evaluate(() => document.querySelector("#qr canvas").dataset.code);
ok("1 Phone B signs up as a separate merchant (access code shown once), starts at ₹0.00 and shows its receiving QR", /\S{8,}/.test(access) && b0 === 0 && /^[A-Za-z0-9_-]{6,64}$/.test(qrCode));

// Phone A's camera will literally show Phone B's QR
const pngPath = join(work, "phoneB-qr.png");
const y4mPath = join(work, "phoneB-qr.y4m");
writeFileSync(pngPath, Buffer.from(qrPng.split(",")[1], "base64"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-i", pngPath, "-t", "2", "-vf", "scale=520:520,pad=960:720:(ow-iw)/2:(oh-ih)/2:white", "-pix_fmt", "yuv420p", "-r", "10", y4mPath]);

// ------------------------------------------------------------ Phone A: the customer
const A = await phone("iPhone 13", ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4mPath}`]);
await A.ctx.grantPermissions(["camera"], { origin: base });
await A.page.goto(`${base}/pay.html`);
await A.page.click(`[data-go="#/customer"]`);
await A.page.waitForSelector("#join");
await A.page.fill("#join [name=n]", "Ravi");
await A.page.click("#join button");
await A.page.waitForSelector("[data-btc]");
await A.page.waitForFunction(() => document.querySelector("#conn")?.dataset.state === "live", null, { timeout: 15000 });
const a0 = await customerSats(A.page);
await shot(A.page, "A1-demo-btc-wallet");
ok("2 Phone A signs in as a customer and sees its DEMO BTC balance from the server (funded once: 1,000,000 sats)", a0 === "1000000" && (await A.page.textContent("[data-btc]")) === "0.01000000");

await A.page.click(`[data-go="#/scan"]`);
await A.page.waitForSelector("#amt", { timeout: 30000 }); // the camera decoded Phone B's QR and opened the request
await shot(A.page, "A2-scanned-request");
const merchantShown = await A.page.textContent(".merchant");
await A.page.fill("#amt [name=a]", "250");
await A.page.click("#amt button");
await A.page.waitForSelector("[data-quote]");
const quote = await A.page.evaluate(() => document.querySelector("[data-quote]").textContent.replace(/\s+/g, " "));
await shot(A.page, "A3-quote");
ok("3 the camera scans Phone B's real QR; the quote shows ₹250.00, the BTC amount, the rate, its source and a countdown", merchantShown === "Chai Point" && /₹250\.00/.test(quote) && /DEMO BTC/.test(quote) && /per BTC/.test(quote) && /\d+ s/.test(quote));

// confirm: tap twice quickly (a double-tap must not pay twice)
const histBefore = await A.page.evaluate(async () => (await window.__pay.api.history("customer")).payments.length);
await A.page.evaluate(() => {
  const b = document.querySelector("#confirm");
  b.click();
  b.click();
});
await A.page.waitForSelector("[data-receipt]", { timeout: 30000 });
await A.page.waitForTimeout(400);
const receiptA = await A.page.evaluate(() => ({ id: document.querySelector("[data-txid]").textContent, text: document.querySelector("[data-receipt]").textContent.replace(/\s+/g, " ") }));
await shot(A.page, "A4-receipt");
const pay = await A.page.evaluate((id) => window.__pay.api.payment(id), receiptA.id);
const a1 = await customerSats(A.page);
const histAfter = await A.page.evaluate(async () => (await window.__pay.api.history("customer")).payments.length);
ok("4 Phone A: confirmed receipt; DEMO BTC dropped by exactly the quoted satoshis, once (double-tap → one payment)", pay.status === "confirmed" && BigInt(a0) - BigInt(a1) === BigInt(pay.btcSats) && histAfter === histBefore + 1 && /Payment confirmed/.test(receiptA.text) && /SIMULATED BTC → INR SETTLEMENT/.test(receiptA.text));

// ------------------------------------------------------------ Phone B: live notification, credit, same receipt
const notified = await B.page.waitForFunction(() => /Payment received · ₹250\.00/.test(document.querySelector("#toast")?.textContent || ""), null, { timeout: 10000 }).then(() => true, () => false);
const shownInr = await B.page.textContent("[data-inr]");
await shot(B.page, "B4-live-notification");
const b1 = await merchantPaise(B.page);
await B.page.click("#toast a");
await B.page.waitForSelector("[data-receipt]");
const receiptB = await B.page.evaluate(() => ({ id: document.querySelector("[data-txid]").textContent, text: document.querySelector("[data-receipt]").textContent.replace(/\s+/g, " ") }));
await shot(B.page, "B5-same-receipt");
ok("5 Phone B is notified live over the WebSocket (no refresh) and its DEMO INR rises by exactly ₹250.00", notified && shownInr === "₹250.00" && b1 - b0 === 25000 && b1 === pay.inrPaise);
ok("6 both phones show the same receipt: same transaction ID, order ID, amounts and names", receiptB.id === receiptA.id && receiptB.text.includes(pay.orderId) && receiptA.text.includes(pay.orderId) && /from Ravi|Ravi/.test(receiptB.text));

// ------------------------------------------------------------ a fixed-amount, single-use QR
await B.page.click(`[data-receipt] [data-go]`);
await B.page.waitForSelector("#fixed", { state: "attached" });
await B.page.evaluate(() => (document.querySelector("#fixed").closest("details").open = true));
await B.page.fill("#fixed [name=a]", "120");
await B.page.fill("#fixed [name=r]", "Table 4");
await B.page.click("#fixed button");
await B.page.waitForFunction(() => /₹120\.00/.test(document.querySelector("#qr-note")?.textContent || ""));
await shot(B.page, "B6-fixed-qr");
const fixedCode = await B.page.evaluate(() => document.querySelector("#qr canvas").dataset.code);
await A.page.goto(`${base}/pay.html#/r/${fixedCode}`); // as if a phone camera opened the QR link
await A.page.waitForSelector("#amt [name=a][readonly]");
await A.page.click("#amt button");
await A.page.waitForSelector("#confirm");
await A.page.click("#confirm");
await A.page.waitForSelector("[data-receipt]", { timeout: 30000 });
const fixedOk = /Table 4/.test(await A.page.textContent("[data-receipt]"));
await A.page.goto(`${base}/pay.html#/r/${fixedCode}`); // scan the same single-use QR again
const reuse = await A.page.waitForSelector(".err", { timeout: 10000 }).then((e) => e.textContent(), () => "");
await shot(A.page, "A6-reused-qr-refused");
ok("7 a fixed ₹120 request (reference shown) is paid once; scanning it again is refused (single use)", fixedOk && /already been paid/.test(reuse));

// ------------------------------------------------------------ refresh: everything is still there
await A.page.goto(`${base}/pay.html`);
await A.page.waitForSelector("#hist li a");
const aHist = await A.page.locator("#hist li a").count();
await B.page.reload();
await B.page.waitForSelector("#hist li a");
const bHist = await B.page.locator("#hist li a").count();
const bShown = await B.page.textContent("[data-inr]");
await shot(A.page, "A5-after-refresh");
await shot(B.page, "B7-after-refresh");
ok("8 after a refresh both phones still show their balances and history (merchant stays signed in via its cookie)", aHist >= 2 && bHist >= 2 && bShown === "₹370.00");

for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
console.log("RESULT", JSON.stringify({ rate: pay.inrPerBtc, source: pay.rateSource, paid: pay.btcSats, tx: pay.id, order: pay.orderId, customerSats: { before: a0, after: a1 }, merchantPaise: { before: b0, after: b1 } }));
console.log("LOGS", logs.length ? logs : "none");
await Promise.all([A.browser.close(), B.browser.close()]);
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length || logs.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
process.exit(failed.length || logs.length ? 1 : 0);
