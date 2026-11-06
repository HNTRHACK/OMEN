// Judge-demo steps 5–6 on a LOCAL fork of Whitechain Sepolia: a customer pays Maya gaslessly in
// one browser; Maya's ledger, open in a SEPARATE browser, receives the confirmed payment live,
// exports it to CSV, and refunds it from her own payout wallet.
// Server env: MERCHANT_KEYS=maya-chai:$MERCHANT_KEY (see README "Verify on a local fork").
// Usage: MERCHANT_KEY=... node e2e/merchant-fork.mjs http://localhost:5181/
import { launch, enter, finish, BASE, forkWalletContext, rpc } from "./lib.mjs";

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const MAYA = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // Maya's payout address on the fork deploy
const USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7";
const KEY = process.env.MERCHANT_KEY;
if (!KEY) throw new Error("Set MERCHANT_KEY to the key in the server's MERCHANT_KEYS");
const usdtOf = async (a) => BigInt(await rpc("eth_call", [{ to: USDT, data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
const shots = process.env.SHOTS;
const base = BASE.replace(/\/$/, "");

// --- Maya's own device: the ledger, unlocked with her key, wallet = her payout address
const bM = await launch();
const mctx = await forkWalletContext(bM, MAYA, undefined, { width: 900, height: 900 });
const M = await mctx.newPage();
const mlogs = [];
M.on("pageerror", (e) => mlogs.push(e.message));
await M.goto(`${base}/merchant.html?m=maya-chai`);
await M.fill("#m-key", "definitely-wrong");
await M.click("#unlock button[type=submit]");
await M.waitForTimeout(800);
const wrongKeyRefused = (await M.isVisible("#unlock")) && /doesn't open/.test(await M.textContent("#m-status"));
await M.fill("#m-key", KEY);
await M.click("#unlock button[type=submit]");
await M.waitForSelector("#board:not([hidden])");
const live = await M.waitForFunction(() => document.querySelector("#m-status").classList.contains("on"), null, { timeout: 15000 }).then(() => true, () => false);
await M.click("#wallet");
await M.waitForFunction(() => /refunds enabled/.test(document.querySelector("#w-info").textContent), null, { timeout: 20000 });

// --- the customer's browser: pay Maya, gasless
const bP = await launch();
const pctx = await forkWalletContext(bP, PAYER);
const { page: P, logs: plogs } = await enter({ newContext: async () => pctx }, BASE);
await P.click("#wallet-btn");
await P.click("[data-act=connect]");
await P.waitForFunction(() => /0x7099/.test(document.querySelector(".acct")?.textContent || ""));
await P.click("[data-act=close]");
await P.evaluate(() => {
  const o = window.__omen;
  o.stand(o.signs["maya-chai"].front(), o.signs["maya-chai"].at);
});
await P.waitForTimeout(500);
await P.keyboard.press("e");
for (let i = 0; i < 3; i++) await P.click("[data-act=next]");
await P.waitForSelector("#q-f");
await P.check("input[value=masala]");
await P.click("#q-f button[type=submit]");
await P.waitForSelector("[data-act=approve]", { timeout: 30000 });
await P.click("[data-act=approve]");
await P.waitForSelector(".receipt", { timeout: 120000 });
const paidAt = Date.now();
const pay = await P.evaluate(() => JSON.parse(localStorage.getItem("omen.payments.v1"))[0]);

// --- Maya's ledger hears about it on its own
const heard = await M.waitForFunction((tx) => !document.querySelector("#flash").hidden && document.querySelector("#flash").innerHTML.includes(tx.slice(0, 8)), pay.txHash, { timeout: 15000 }).then(() => true, () => false);
const latencyMs = Date.now() - paidAt;
const flashText = (await M.textContent("#flash")).replace(/\s+/g, " ").trim();
console.log(`MERCHANT NOTIFIED in <= ${latencyMs} ms after the customer's receipt:`, flashText.slice(0, 260));
if (shots) await M.screenshot({ path: `${shots}/merchant-ledger.png`, fullPage: true });
const honestInr = /DEMO INR SETTLEMENT/.test(flashText) && !/UTR|bank ref|credited to your bank/i.test(flashText);

// CSV export contains the settled tx
const [dl] = await Promise.all([M.waitForEvent("download"), M.click("#csv")]);
const csv = await (await import("node:fs/promises")).readFile(await dl.path(), "utf8");
const csvHasTx = csv.includes(pay.txHash) && csv.split("\n")[0].startsWith("createdAt,id,state");

// --- Maya refunds it from her payout wallet
const before = await usdtOf(PAYER);
M.on("dialog", (d) => d.accept());
await M.click(`[data-refund="${pay.id}"]`);
const refunded = await M.waitForFunction(() => /refunded/.test(document.querySelector("#list").textContent), null, { timeout: 60000 }).then(() => true, () => false);
const after = await usdtOf(PAYER);
console.log(`REFUND: payer USDT ${before} -> ${after} (+${after - before}, order was ${pay.quote.tokenUnits})`);

const logs = [...mlogs, ...plogs];
console.log("LOGS", logs.join("\n") || "none");
await bM.close();
await bP.close();
finish({
  wrongKeyRefused,
  merchantLive: live,
  customerPaid: pay.state === "COMPLETED" && pay.relayed === true,
  merchantNotifiedLive: heard,
  honestInrLabel: honestInr,
  csvHasTx,
  refundedFromMerchantWallet: refunded && after - before === BigInt(pay.quote.tokenUnits),
  noPageErrors: logs.length === 0,
});
