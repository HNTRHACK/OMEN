// Gasless (Whitechain Operate) checkout at Maya's stall, through the real UI, against a LOCAL anvil
// fork of Whitechain Sepolia. The payer holds 0 WBT; the test fails if the payer is ever asked to
// send a transaction. The injected provider stands in for a browser wallet and forwards to anvil,
// whose dev accounts are unlocked (so no keys are involved here).
//
// Setup: README "Verify the gasless flow on a local fork". Usage:
//   node e2e/gasless-fork.mjs http://localhost:5181/
import { launch, enter, finish, BASE } from "./lib.mjs";

const RPC = process.env.FORK_RPC || "http://127.0.0.1:8545";
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7";

const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const usdtOf = async (a) => BigInt(await rpc("eth_call", [{ to: USDT, data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
const before = { usdt: await usdtOf(PAYER), wbt: BigInt(await rpc("eth_getBalance", [PAYER, "latest"])), nonce: Number(await rpc("eth_getTransactionCount", [PAYER, "latest"])) };

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(({ PAYER, RPC }) => {
  window.__walletCalls = [];
  window.ethereum = {
    on() {},
    async request({ method, params }) {
      window.__walletCalls.push(method);
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [PAYER];
      if (method === "wallet_switchEthereumChain") {
        if (parseInt(params[0].chainId, 16) === 1874) return null;
        throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
      }
      if (method === "wallet_addEthereumChain") return null;
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    },
  };
}, { PAYER, RPC });
const { page, logs } = await enter({ newContext: async () => ctx }, BASE);

await page.click("#wallet-btn");
await page.click("[data-act=connect]");
await page.waitForFunction(() => /0x7099/.test(document.querySelector(".acct")?.textContent || ""));
await page.click("[data-act=close]");
await page.evaluate(() => {
  const o = window.__omen;
  o.stand(o.signs["maya-chai"].front(), o.signs["maya-chai"].at);
});
await page.waitForTimeout(600);
await page.keyboard.press("e");
await page.waitForSelector("#pay:not([hidden])");
for (let i = 0; i < 3; i++) await page.click("[data-act=next]");
await page.waitForSelector("#q-f");
await page.check("input[value=masala]");
await page.click("#q-f button[type=submit]");
await page.waitForSelector("[data-act=approve]", { timeout: 30000 });
const quote = (await page.textContent(".quote")).replace(/\s+/g, " ").trim();
console.log("QUOTE", quote);
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/gasless-quote.png` });
await page.click("[data-act=approve]");
await page.waitForSelector(".receipt", { timeout: 120000 });
await page.waitForTimeout(1500);
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/gasless-receipt.png` });
const receipt = (await page.textContent(".receipt")).replace(/\s+/g, " ").trim();
console.log("RECEIPT", receipt.slice(0, 700));
const calls = await page.evaluate(() => window.__walletCalls);
const walletAsks = calls.filter((m) => /^eth_(send|sign)|personal_sign|wallet_/.test(m));
console.log("WALLET REQUESTS", walletAsks.join(", "));
const pay = await page.evaluate(() => JSON.parse(localStorage.getItem("omen.payments.v1"))[0]);
console.log("TX", pay.txHash, "state", pay.state, "relayed", pay.relayed);

const after = { usdt: await usdtOf(PAYER), wbt: BigInt(await rpc("eth_getBalance", [PAYER, "latest"])), nonce: Number(await rpc("eth_getTransactionCount", [PAYER, "latest"])) };
const tx = await rpc("eth_getTransactionByHash", [pay.txHash]);
const rcpt = await rpc("eth_getTransactionReceipt", [pay.txHash]);
console.log(`PAYER USDT ${before.usdt} -> ${after.usdt} | WBT ${before.wbt} -> ${after.wbt} | nonce ${before.nonce} -> ${after.nonce}`);
console.log(`TX from ${tx.from} (relayer) to ${tx.to}, status ${rcpt.status}, gasUsed ${parseInt(rcpt.gasUsed, 16)}`);
await browser.close();

finish({
  completed: pay.state === "COMPLETED" && pay.relayed === true,
  payerSentNoTransaction: !calls.includes("eth_sendTransaction") && after.nonce === before.nonce,
  payerSpentNoGas: after.wbt === before.wbt && before.wbt === 0n,
  payerPaidExactQuote: before.usdt - after.usdt === BigInt(pay.quote.tokenUnits),
  relayerSentTheTx: tx.from.toLowerCase() !== PAYER.toLowerCase() && rcpt.status === "0x1",
  oneSignatureOnly: calls.filter((m) => m === "eth_signTypedData_v4").length === 1,
  receiptShowsBalance: /Your USDT/.test(receipt) && /₹0 for you/.test(receipt),
  noPageErrors: logs.length === 0,
});
