// Tutorial = learn to pay. KAI buys Maya a cup through ChaiPay on Whitechain Sepolia:
// wallet → escrow balance → EIP-712 signature (no gas) → ChaiPay relayer → order on-chain.
// If anything real is missing (no verified human, no wallet, relayer down), the same lesson runs
// as a clearly labelled SIMULATION. We never show an explorer link we didn't get from the chain.
import { erc20Abi, formatUnits } from "viem";
import { wallet, whitechain } from "../pay/wallet.js";
import { USDT } from "../../shared/chains.js";
import { CHAIPAY, CHAIPAY_ABI, PAY_DOMAIN, PAY_TYPES, TUTORIAL_PAYEE_HASH, TUTORIAL_PRICE } from "../../shared/chaipay.js";
import { human, linkWallet } from "./gate.js";

const usdt = (v) => formatUnits(BigInt(v), USDT.decimals);

/**
 * Run the payment lesson. `say(name, text, {choices})` is the game's dialogue line.
 * Resolves { mode: "testnet", txHash, orderId, explorer } or { mode: "simulated", reason }.
 */
export async function tutorialPayment(say) {
  const taught = new Set();
  const sim = async (reason) => {
    await say("MAYA", `Then we'll practise it as a SIMULATION. (${reason})`);
    if (!taught.has("escrow")) await say("MAYA", "ESCROW: ChaiPay would hold your 0.25 test USDT in a locked order — released to the shop once it's paid, or back to you if not.");
    if (!taught.has("signature")) await say("MAYA", "SIGNATURE: your wallet would show who, how much and until when, and you'd sign. Signing is free.");
    await say("MAYA", "GAS: the network's fee. The ChaiPay relayer pays it for you when it submits your signed intent.");
    await say("SIMULATED", "Signed intent → relayer → escrow order … no real transaction was sent. Testnet tokens only. No real money. Just for fun.");
    return { mode: "simulated", reason };
  };

  await say("MAYA", "Before the lanterns: your turn to pay for something. One cup, ₹20 — that's 0.25 test USDT at our demo rate.");
  await say("MAYA", "Lesson one: a WALLET is just your key. It proves the money is yours. Nobody here ever sees the key.");

  if (!human.current) return sim("you're playing unverified, so no real testnet payment");
  if (!human.current.wallet) {
    const pick = await say("MAYA", "You don't have a wallet linked to your World ID yet.", { choices: [{ label: "Link my wallet now", value: "link" }, { label: "Simulate it", value: "sim" }] });
    if (pick !== "link") return sim("no wallet linked");
    try {
      await linkWallet();
    } catch (e) {
      return sim(e.shortMessage || e.message);
    }
  }
  try {
    if (!wallet.address) await wallet.connect();
    await wallet.ensureChain(whitechain);
  } catch (e) {
    return sim(e.shortMessage || e.message);
  }
  if (wallet.address !== human.current.wallet) return sim("the connected wallet isn't the one linked to your World ID");
  const payer = wallet.address;

  // ESCROW: ChaiPay holds a small balance for you; a payment moves it into an escrowed order.
  const read = (functionName) => wallet.pub.readContract({ address: CHAIPAY.address, abi: CHAIPAY_ABI, functionName, args: [payer] });
  let [bal, nonce] = await Promise.all([read("balanceOf"), read("nonces")]).catch(() => [null, null]);
  if (bal === null) return sim("couldn't read ChaiPay on Whitechain Sepolia");
  await say("MAYA", `Lesson two: ESCROW. ChaiPay keeps a little balance for you — you have ${usdt(bal)} test USDT in it. When you pay, it's locked in an order until the shop is paid, or it comes back to you.`);

  taught.add("escrow");
  if (bal < TUTORIAL_PRICE.usdtAmount) {
    const pick = await say("MAYA", "Your escrow is empty. Topping up is a normal transaction: approve, then deposit 1 test USDT. That one costs GAS — a pinch of WBT for the network.", {
      choices: [{ label: "Top up 1 test USDT (I pay a little WBT gas)", value: "top" }, { label: "Simulate instead", value: "sim" }],
    });
    if (pick !== "top") return sim("escrow not topped up");
    try {
      const amount = 1_000_000n;
      const have = await wallet.usdtBalance();
      if (have < amount) return sim(`you have ${usdt(have)} test USDT; get some from the Whitechain faucet first`);
      const w = wallet.client();
      const allowance = await wallet.pub.readContract({ address: USDT.address, abi: erc20Abi, functionName: "allowance", args: [payer, CHAIPAY.address] });
      if (allowance < amount) {
        const h = await w.writeContract({ address: USDT.address, abi: erc20Abi, functionName: "approve", args: [CHAIPAY.address, amount] });
        await wallet.pub.waitForTransactionReceipt({ hash: h });
      }
      const h2 = await w.writeContract({ address: CHAIPAY.address, abi: CHAIPAY_ABI, functionName: "deposit", args: [amount] });
      const r = await wallet.pub.waitForTransactionReceipt({ hash: h2 });
      if (r.status !== "success") return sim("the deposit reverted");
      bal = await read("balanceOf");
      await say("MAYA", `Topped up: ${usdt(bal)} test USDT in escrow. You just paid gas — notice how that felt. The next step won't need any.`);
    } catch (e) {
      return sim(e.shortMessage || e.message);
    }
  }

  // SIGNATURE: an EIP-712 "Pay" intent. Signing is free; the relayer pays the gas to submit it.
  await say("MAYA", "Lesson three: a SIGNATURE. Your wallet will show exactly what you're agreeing to: who, how much, until when. Signing costs nothing.");
  taught.add("signature");
  const intent = { payer, payeeHash: TUTORIAL_PAYEE_HASH, inrPaise: TUTORIAL_PRICE.inrPaise, usdtAmount: TUTORIAL_PRICE.usdtAmount, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
  let signature;
  try {
    signature = await wallet.client().signTypedData({ account: payer, domain: PAY_DOMAIN, types: PAY_TYPES, primaryType: "Pay", message: intent });
  } catch (e) {
    return sim(e.shortMessage || "signature declined");
  }
  await say("MAYA", "Lesson four: GAS, again. The ChaiPay relayer submits your signed intent and pays the gas for you. Off it goes…");
  let out;
  try {
    const r = await fetch("/api/chaipay/pay", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: Object.fromEntries(Object.entries(intent).map(([k, v]) => [k, String(v)])), signature }) });
    out = await r.json();
    if (!r.ok) return sim(out.error === "relayer_unreachable" ? "the ChaiPay relayer is unreachable" : out.message || "the relayer refused");
  } catch {
    return sim("the ChaiPay relayer is unreachable");
  }
  await say("MAYA", `It's on-chain! Order #${out.orderId}, ${usdt(out.usdtAmount)} test USDT in escrow for my stall. Testnet tokens only — no real money.`);
  return { mode: "testnet", ...out };
}
