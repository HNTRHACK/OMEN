// THE JUDGE JOURNEY, two independent browsers on a LOCAL anvil fork of Whitechain Sepolia.
//   Judge enters → customises an avatar → meets another player → discovers a business → sees an ad →
//   talks to Alfred → buys with gasless Whitechain USDT → the merchant is notified live → the
//   transaction is verified on-chain → both join the forum → a B2B invoice between two shops is paid
//   → refresh: everything persists.
//
// Setup (README "Verify on a local fork"): anvil fork on :8545, `bash scripts/fork-setup.sh`, then the
// server with CHECKOUT_ADDRESS, RELAYER_PRIVATE_KEY and MODERATOR_KEY (same value as MOD_KEY here).
// Usage: MOD_KEY=… CHECKOUT_ADDRESS=0x… node e2e/journey.mjs http://localhost:5181/
// Evidence printed here is from a LOCAL FORK: its tx hashes do not exist on the public explorer.
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";
import { launch, enter, finish, BASE, forkWalletContext, rpc } from "./lib.mjs";
import { directMerchantId } from "../shared/merchants.js";

const MOD_KEY = process.env.MOD_KEY;
const CHECKOUT = (process.env.CHECKOUT_ADDRESS || "").toLowerCase();
if (!MOD_KEY || !CHECKOUT) throw new Error("Set MOD_KEY and CHECKOUT_ADDRESS (see the header of this file)");
const base = BASE.replace(/\/$/, "");
const shots = process.env.SHOTS;
const shot = (page, name) => (shots ? page.screenshot({ path: `${shots}/journey-${name}.png` }).catch(() => {}) : null);
const IMAGE = fileURLToPath(new URL("../docs/screens/coin-card.png", import.meta.url));

const RAVI_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // funded by fork-setup: 50 USDT, 0 WBT
const ASHA_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // her shop's payout wallet (anvil dev account)
const USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7";
const PAID_TOPIC = keccak256(toBytes("Paid(bytes32,bytes32,address,address,uint256,uint256)"));
const usdtOf = async (a) => BigInt(await rpc("eth_call", [{ to: USDT, data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
const nonceOf = async (a) => Number(await rpc("eth_getTransactionCount", [a, "latest"]));
const wbtOf = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));

const checks = {};
const ok = (name, v) => (checks[name] = !!v);
const waitFn = (page, fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

// ------------------------------------------------------------------ 1. two judges enter
const [bA, bB] = await Promise.all([launch(), launch()]);
const A = await enter(bA, BASE, { name: "Asha", look: { skin: 2, hair: 2, hairStyle: 1, hat: 3, jacket: 3, accessory: 1, pet: 1 } });
const ctxB = await forkWalletContext(bB, RAVI_WALLET);
const B = await enter({ newContext: async () => ctxB }, BASE, { name: "Ravi", look: { skin: 3, jacket: 1, hat: 4, accessory: 2, pet: 2 } });
let rateLimited = 0;
for (const P of [A.page, B.page]) {
  P.setDefaultTimeout(60000);
  P.on("response", (r) => r.status() === 429 && (rateLimited++, console.log("429 rate limited:", r.url().replace(base, ""))));
  await P.evaluate(() => {
    window.__toasts = [];
    window.__feed = [];
    new MutationObserver(() => window.__toasts.push(document.getElementById("toast").textContent)).observe(document.getElementById("toast"), { childList: true, characterData: true, subtree: true });
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__feed.push(n.textContent)))).observe(document.getElementById("feed"), { childList: true });
  });
}
const toasted = (page, re, ms = 20000) => waitFn(page, (s) => window.__toasts.some((t) => new RegExp(s).test(t)), re.source, ms);
const stand = (page, expr) => page.evaluate(`(() => { const o = window.__omen; ${expr} })()`);
const atStall = (page, id) => stand(page, `o.stand(o.stalls["${id}"].front(), o.stalls["${id}"].group.position)`);

// ------------------------------------------------------------------ 2. they meet
ok("1 both judges see each other, with their avatars", await waitFn(A.page, () => [...window.__omen.net.remotes.values()].some((r) => r.name === "Ravi" && r.c.group.visible && r.c.look.hat === 4 && r.pet?.kind === 2)) && (await waitFn(B.page, () => [...window.__omen.net.remotes.values()].some((r) => r.name === "Asha" && r.c.group.visible && r.c.look.hat === 3 && r.pet?.kind === 1))));

// ------------------------------------------------------------------ 3. Asha opens a business
await atStall(A.page, "plot-lantern");
await A.page.waitForTimeout(700);
await A.page.keyboard.press("e");
await A.page.waitForSelector("#claim-f");
await A.page.fill("#claim-f [name=name]", "Asha's Chai Cart");
await A.page.fill("#claim-f [name=tagline]", "Masala chai, made to order");
await A.page.fill("#claim-f [name=payout]", ASHA_WALLET);
await A.page.click("#claim-f .sw-pick:nth-child(4)");
await A.page.click("#claim-f button.btn");
await A.page.waitForSelector("#prod-f");
await A.page.fill("#prod-f [name=name]", "Masala chai");
await A.page.fill("#prod-f [name=price]", "60");
await A.page.fill("#prod-f [name=stock]", "20");
await A.page.click("#prod-f button");
await waitFn(A.page, () => /Masala chai/.test(document.querySelector("#shop .catalog")?.textContent || ""));
ok("2 Asha claimed a stall with a payout wallet and listed a product", await waitFn(B.page, () => window.__omen.stalls["plot-lantern"].shop?.name === "Asha's Chai Cart"));
await A.page.keyboard.press("Escape");

// ------------------------------------------------------------------ 4. an advertisement, moderated, live for others
await stand(A.page, `const b = o.community.boards[0]; o.stand(b.front(), b.group.position)`);
await A.page.waitForTimeout(700);
await A.page.keyboard.press("e");
await A.page.waitForSelector("#ad-f", { state: "attached" });
await A.page.evaluate(() => (document.querySelector("#ad-f").closest("details").open = true));
await A.page.setInputFiles("#ad-f [name=file]", IMAGE);
await A.page.fill("#ad-f [name=brand]", "Asha's Chai");
await A.page.fill("#ad-f [name=title]", "Asha's Chai Cart");
await A.page.fill("#ad-f [name=text]", "Masala chai, 60 rupees, at the Lantern stall");
await A.page.waitForTimeout(800);
await A.page.click("#ad-f [data-submit]");
await A.page.waitForSelector("#forum .ok");
const modHeaders = { "x-mod-key": MOD_KEY, "content-type": "application/json" };
const queue = await (await fetch(`${base}/api/mod/queue`, { headers: modHeaders })).json();
const pending = queue.pendingAds.find((a) => a.title === "Asha's Chai Cart");
ok("3a the ad waits for review (not shown yet)", !!pending && (await B.page.evaluate(() => window.__omen.community.boards[0].shown)) === null);
await fetch(`${base}/api/mod`, { method: "POST", headers: modHeaders, body: JSON.stringify({ action: "approve", id: pending.id }) });
ok("3b after moderator approval the ad is live on Ravi's screen", await waitFn(B.page, () => window.__omen.community.boards[0].shown?.title === "Asha's Chai Cart"));
await A.page.keyboard.press("Escape");
await stand(B.page, `const b = o.community.boards[0]; o.stand(b.front(), b.group.position)`);
await B.page.waitForTimeout(1500);
await shot(B.page, "1-ad-live");

// ------------------------------------------------------------------ 5. Ravi talks to Alfred
await stand(B.page, `o.stand(o.alfred.local(0, 0, 1.5), o.alfred.group.position)`);
await B.page.waitForTimeout(900);
await B.page.keyboard.press("e");
await B.page.waitForSelector("#alfred:not([hidden]) .al-msg.alfred");
await B.page.click('#al-chips [data-starter="0"]');
await B.page.waitForSelector("#al-log .al-label");
ok("4 Alfred answers, honestly labelled", /^(Offline answer|AI ·)/.test(await B.page.textContent("#al-log .al-label")));
await B.page.keyboard.press("Escape");

// ------------------------------------------------------------------ 6. Ravi discovers the business and buys with USDT
await atStall(B.page, "plot-lantern");
await B.page.waitForTimeout(900);
const browsePrompt = await B.page.textContent("#prompt-text");
await B.page.keyboard.press("e");
await B.page.waitForSelector("#shop .catalog [data-inc]");
await B.page.click("#shop .catalog [data-inc]");
await waitFn(B.page, () => document.querySelector("#shop .basket b")?.textContent === "₹60.00");
await shot(B.page, "2-shop-browse");
const usdtEnabled = await B.page.isEnabled("[data-pay=USDT]");

const before = { ravi: await usdtOf(RAVI_WALLET), asha: await usdtOf(ASHA_WALLET), raviWbt: await wbtOf(RAVI_WALLET), raviNonce: await nonceOf(RAVI_WALLET) };
// The local fork lazily fetches state from the public testnet RPC, which sometimes times out. The app
// reports that honestly ("node isn't responding, nothing charged"); a user would simply try again, so
// the test does too, up to 4 times, and says how many retries it took.
let quote;
let payTries = 0;
for (;;) {
  payTries++;
  await B.page.click("[data-pay=USDT]");
  await B.page.waitForSelector("#pay [data-act=approve]");
  quote = (await B.page.textContent("#pay .quote")).replace(/\s+/g, " ");
  if (payTries === 1) await shot(B.page, "3-quote");
  await B.page.click("[data-act=approve]");
  const outcome = await B.page.waitForSelector("#pay .receipt, #pay h2#pay-h:has-text('Not paid')", { timeout: 120000 });
  if (await B.page.$("#pay .receipt")) break;
  const msg = (await B.page.textContent("#pay .pay-body")).replace(/\s+/g, " ");
  console.log(`  attempt ${payTries}: not paid ->`, msg.slice(0, 200));
  { const t0 = Date.now(); const probe = await rpc("eth_getStorageAt", [USDT, "0x" + [...Array(64)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""), "latest"]).then(() => "ok", (e) => String(e).slice(0, 120)); console.log(`  probe fresh slot after failure: ${probe} in ${Date.now() - t0} ms`); }
  if (!/isn't responding/.test(msg) || payTries >= 4) throw new Error("purchase failed: " + msg.slice(0, 300));
  await B.page.click("#pay [data-act=close]");
  await B.page.keyboard.press("e");
  await B.page.waitForSelector("#shop .catalog [data-inc]");
  await B.page.click("#shop .catalog [data-inc]");
  await waitFn(B.page, () => document.querySelector("#shop .basket b")?.textContent === "₹60.00");
}
if (payTries > 1) console.log(`  (purchase needed ${payTries} attempts because of local-fork upstream timeouts)`);
await B.page.waitForTimeout(1200);
const receipt = (await B.page.textContent("#pay .receipt")).replace(/\s+/g, " ");
await shot(B.page, "4-receipt");
const pay1 = await B.page.evaluate(() => JSON.parse(localStorage.getItem("omen.payments.v1"))[0]);
ok("5a shop shows USDT as payable and the quote is gasless", browsePrompt === "Browse Asha's Chai Cart" && usdtEnabled && /₹0 for you/.test(quote) && /Recipient\s*Asha's Chai Cart/.test(quote));
ok("5b receipt: TESTNET CRYPTO, gas ₹0, paid-to wallet, DEMO INR SETTLEMENT", /TESTNET CRYPTO PAYMENT/.test(receipt) && /₹0 for you/.test(receipt) && /Paid to/.test(receipt) && /DEMO INR SETTLEMENT/.test(receipt) && pay1.state === "COMPLETED");

// ------------------------------------------------------------------ 7. the merchant is notified; the chain agrees
ok("6a Asha was notified live of the PAID order", await toasted(A.page, /New order PAID: 1× Masala chai from Ravi \(TESTNET CRYPTO\)/));
await atStall(A.page, "plot-lantern");
await A.page.waitForTimeout(700);
await A.page.keyboard.press("e");
await A.page.waitForSelector("[data-dtab=orders]");
await A.page.click("[data-dtab=orders]");
ok("6b her dashboard lists the order with its transaction", await waitFn(A.page, () => /Masala chai[\s\S]*from Ravi[\s\S]*PAID[\s\S]*tx/.test(document.querySelector("#shop .hist")?.textContent || "")));
await shot(A.page, "5-merchant-notified");
await A.page.keyboard.press("Escape");

const after = { ravi: await usdtOf(RAVI_WALLET), asha: await usdtOf(ASHA_WALLET), raviWbt: await wbtOf(RAVI_WALLET), raviNonce: await nonceOf(RAVI_WALLET) };
const rcpt = await rpc("eth_getTransactionReceipt", [pay1.txHash]);
const tx = await rpc("eth_getTransactionByHash", [pay1.txHash]);
const paidLog = rcpt.logs.find((l) => l.address.toLowerCase() === CHECKOUT && l.topics[0] === PAID_TOPIC);
const units = BigInt(pay1.quote.tokenUnits);
const gateway = await (await fetch(`${base}/api/payments/${pay1.id}`)).json();
ok("7a on-chain: tx succeeded, called our checkout, sent by the relayer (not Ravi)", rcpt.status === "0x1" && tx.to.toLowerCase() === CHECKOUT && tx.from.toLowerCase() !== RAVI_WALLET.toLowerCase());
ok("7b on-chain: Paid event names Asha's direct merchant id", paidLog?.topics[2] === directMerchantId(ASHA_WALLET).toLowerCase());
ok("7c Asha's wallet received exactly the quoted USDT; Ravi paid exactly that", after.asha - before.asha === units && before.ravi - after.ravi === units);
ok("7d Ravi sent no transaction and spent no gas (0 WBT, same nonce)", after.raviNonce === before.raviNonce && after.raviWbt === before.raviWbt && before.raviWbt === 0n);
ok("7e the gateway verified it independently (COMPLETED, ≥1 confirmation)", gateway.state === "COMPLETED" && gateway.onchain?.confirmations >= 1 && gateway.onchain.payout.toLowerCase() === ASHA_WALLET.toLowerCase());

// ------------------------------------------------------------------ 8. forum: a conversation between the two judges
await A.page.evaluate(() => window.__omen.community.openForum());
await A.page.waitForSelector("#thread-f", { state: "attached" });
await A.page.click(".new-thread summary");
await A.page.fill("#thread-f [name=title]", "Fresh masala chai at the Lantern stall");
await A.page.fill("#thread-f [name=body]", "Open now. Bulk orders welcome via B2B invoice.");
await A.page.click("#thread-f button");
await A.page.waitForSelector("#reply-f");
ok("8a Ravi hears about the new thread live", await waitFn(B.page, () => window.__feed.some((t) => /Asha started “Fresh masala chai at the Lantern stall”/.test(t))));
await B.page.evaluate(() => window.__omen.community.openForum());
await B.page.waitForSelector("[data-thread]");
await B.page.click("[data-thread]");
await B.page.waitForSelector("#reply-f");
await B.page.fill("#reply-f textarea", "Just bought one with testnet USDT, no gas. Smooth!");
await B.page.click("#reply-f button");
ok("8b Asha sees Ravi's reply live", await waitFn(A.page, () => /Smooth!/.test(document.querySelector("#forum .posts")?.textContent || "")));
await shot(A.page, "6-forum");
await A.page.keyboard.press("Escape");
await B.page.keyboard.press("Escape");

// ------------------------------------------------------------------ 9. B2B: Ravi opens a stall; Asha invoices it; Ravi pays with USDT
// Ravi closes the receipt he was reading, as a person would, before walking on.
if (await B.page.$("#pay .receipt")) await B.page.click("#pay [data-act=close]");
await B.page.waitForTimeout(500);
await atStall(B.page, "plot-east");
await B.page.waitForTimeout(900);
await B.page.keyboard.press("e");
await B.page.waitForSelector("#claim-f").catch(async (e) => {
  console.log("DIAGNOSTIC claim:", await B.page.evaluate(() => JSON.stringify({ prompt: document.getElementById("prompt-text")?.textContent, open: [...document.querySelectorAll("#shop,#forum,#pay,#alfred,#creator")].map((n) => n.id + (n.hidden ? ":hidden" : ":open")), shop: document.querySelector("#shop")?.textContent.replace(/\s+/g, " ").slice(0, 200) })));
  throw e;
});
await B.page.fill("#claim-f [name=name]", "Ravi's Teas");
await B.page.click("#claim-f button.btn");
await B.page.waitForSelector("#prod-f");
await B.page.keyboard.press("Escape");

await atStall(A.page, "plot-lantern");
await A.page.waitForTimeout(700);
await A.page.keyboard.press("e");
await A.page.waitForSelector("[data-dtab=invoices]");
await A.page.click("[data-dtab=invoices]");
await A.page.waitForSelector("#inv-f");
await A.page.selectOption("#inv-f [name=to]", { label: "Ravi's Teas (Ravi)" });
await A.page.fill("#inv-f [name=name]", "Masala chai, wholesale");
await A.page.fill("#inv-f [name=qty]", "10");
await A.page.fill("#inv-f [name=price]", "40");
await A.page.fill("#inv-f [name=memo]", "Festival stock");
await A.page.click("#inv-f button");
ok("9a Ravi's shop is notified of the invoice live", await toasted(B.page, /Invoice from Asha's Chai Cart: ₹400\.00/));
await A.page.keyboard.press("Escape");

await atStall(B.page, "plot-east");
await B.page.waitForTimeout(900);
await B.page.keyboard.press("e");
await B.page.waitForSelector("[data-dtab=invoices]");
await B.page.click("[data-dtab=invoices]");
await B.page.waitForSelector('[data-payinv][data-tok="USDT"]');
await shot(B.page, "7-invoice");
const before2 = { asha: await usdtOf(ASHA_WALLET), ravi: await usdtOf(RAVI_WALLET), nonce: await nonceOf(RAVI_WALLET) };
await B.page.click('[data-payinv][data-tok="USDT"]');
await B.page.waitForSelector("#pay [data-act=approve]");
await B.page.click("[data-act=approve]");
await B.page.waitForSelector("#pay .receipt", { timeout: 120000 });
await B.page.waitForTimeout(1000);
const pay2 = await B.page.evaluate(() => JSON.parse(localStorage.getItem("omen.payments.v1"))[0]);
const after2 = { asha: await usdtOf(ASHA_WALLET), ravi: await usdtOf(RAVI_WALLET), nonce: await nonceOf(RAVI_WALLET) };
const units2 = BigInt(pay2.quote.tokenUnits);
ok("9b the invoice was paid with gasless USDT straight to the issuing shop's wallet", pay2.state === "COMPLETED" && pay2.id !== pay1.id && after2.asha - before2.asha === units2 && before2.ravi - after2.ravi === units2 && after2.nonce === before2.nonce);
ok("9c Asha was told her invoice was paid; her books show it", (await toasted(A.page, /Ravi's Teas paid your invoice/)) && (await A.page.evaluate(async () => (await (await fetch("/api/invoices/mine", { headers: { "x-omen-token": localStorage.getItem("omen.identity") } })).json()).sent[0]?.status)) === "paid");
await B.page.keyboard.press("Escape");

// ------------------------------------------------------------------ 10. refresh both: nothing is lost
for (const P of [A.page, B.page]) {
  await P.reload();
  await P.waitForSelector("#continue:not([hidden])", { timeout: 120000 });
  await P.click("#continue");
  await P.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
}
await A.page.waitForTimeout(2500);
const mineA = await A.page.evaluate(async () => {
  const h = { "x-omen-token": localStorage.getItem("omen.identity") };
  const shop = (await (await fetch("/api/shops/mine", { headers: h })).json()).shop;
  const orders = (await (await fetch(`/api/shops/${shop.id}/orders`, { headers: h })).json()).orders;
  return { shop: shop.name, paid: orders.filter((o) => o.status === "paid" && o.txHash).map((o) => o.kind).sort(), ad: window.__omen.community.boards[0].shown?.title };
});
const mineB = await B.page.evaluate(async () => {
  const h = { "x-omen-token": localStorage.getItem("omen.identity") };
  const orders = (await (await fetch("/api/orders/mine", { headers: h })).json()).orders;
  return { orders: orders.filter((o) => o.status === "paid" && o.txHash).map((o) => o.kind).sort(), receipts: JSON.parse(localStorage.getItem("omen.payments.v1")).filter((p) => p.state === "COMPLETED" && p.txHash).length };
});
const forum = await (await fetch(`${base}/api/forum?cat=general`)).json();
ok("10 after a refresh: shop, ad, order history with tx hashes, receipts and the forum thread all persist", mineA.shop === "Asha's Chai Cart" && mineA.ad === "Asha's Chai Cart" && JSON.stringify(mineA.paid) === '["b2b","b2c"]' && JSON.stringify(mineB.orders) === '["b2b","b2c"]' && mineB.receipts >= 2 && forum.threads.some((t) => t.title === "Fresh masala chai at the Lantern stall" && t.replies === 1));

const logs = [...A.logs, ...B.logs];
ok("no page errors in either browser", logs.length === 0);
ok("no request was rate limited (429)", rateLimited === 0);
console.log("\nEVIDENCE (LOCAL FORK of chain 1874; these hashes do not exist on the public explorer)");
console.log(`  shop purchase  tx ${pay1.txHash}  ${pay1.quote.tokenAmount} USDT  (₹${pay1.quote.inrPaise / 100})`);
console.log(`  B2B invoice    tx ${pay2.txHash}  ${pay2.quote.tokenAmount} USDT  (₹${pay2.quote.inrPaise / 100})`);
console.log(`  Asha's wallet  USDT +${after2.asha - before.asha} units over the journey | Ravi spent no gas, sent no transaction`);
console.log("LOGS", logs.join("\n") || "none");
await bA.close();
await bB.close();
finish(checks);
