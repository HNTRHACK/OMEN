// The checkout SDK on a plain web page (public/sdk/demo.html), outside the game, against a LOCAL
// fork: one signature, no transaction or gas from the customer, merchant paid.
// Usage: node e2e/sdk-fork.mjs http://localhost:5181/
import { launch, finish, BASE, forkWalletContext, rpc } from "./lib.mjs";

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const MAYA = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7";
const usdtOf = async (a) => BigInt(await rpc("eth_call", [{ to: USDT, data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
const nonceOf = async (a) => Number(await rpc("eth_getTransactionCount", [a, "latest"]));

const before = { payer: await usdtOf(PAYER), maya: await usdtOf(MAYA), nonce: await nonceOf(PAYER), wbt: await rpc("eth_getBalance", [PAYER, "latest"]) };
const browser = await launch();
const ctx = await forkWalletContext(browser, PAYER, undefined, { width: 700, height: 700 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE.replace(/\/$/, "")}/sdk/demo.html`);
const integrationLines = (await page.evaluate(() => document.querySelector("script[type=module]").textContent.trim().split("\n").length));
await page.click("#pay");
const done = await page.waitForFunction(() => /^Paid/.test(document.querySelector("#status").textContent), null, { timeout: 120000 }).then(() => true, () => false);
const status = await page.textContent("#status");
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/sdk-demo.png` }).catch(() => {});
const calls = await page.evaluate(() => window.__walletCalls);
const after = { payer: await usdtOf(PAYER), maya: await usdtOf(MAYA), nonce: await nonceOf(PAYER), wbt: await rpc("eth_getBalance", [PAYER, "latest"]) };
console.log("STATUS", status);
console.log(`integration snippet: ${integrationLines} lines | wallet: ${calls.filter((m) => /send|sign|request/.test(m)).join(", ")}`);
console.log(`payer USDT -${before.payer - after.payer} | maya USDT +${after.maya - before.maya} | payer nonce ${before.nonce}->${after.nonce} | payer WBT ${before.wbt}->${after.wbt}`);
await browser.close();
finish({
  paid: done,
  merchantCredited: after.maya - before.maya === before.payer - after.payer && after.maya > before.maya,
  oneSignature: calls.filter((m) => m === "eth_signTypedData_v4").length === 1,
  noCustomerTransaction: !calls.includes("eth_sendTransaction") && after.nonce === before.nonce && after.wbt === before.wbt,
  underTwentyLines: integrationLines <= 20,
  noPageErrors: errors.length === 0,
});
