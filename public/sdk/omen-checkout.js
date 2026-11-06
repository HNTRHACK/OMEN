// OMEN Checkout SDK: gasless Whitechain USDT checkout for any web page, in a few lines.
//
//   import { OmenCheckout } from "https://<your OMEN gateway>/sdk/omen-checkout.js";
//   const checkout = new OmenCheckout({ gateway: "https://<your OMEN gateway>", merchant: "maya-chai" });
//   button.onclick = async () => {
//     const receipt = await checkout.pay({ inr: "60.00", note: "Masala chai" }, { onStatus: console.log });
//     console.log(receipt.txHash, receipt.explorer);
//   };
//
// The customer signs ONE off-chain EIP-3009 authorization in their wallet: no transaction, no gas.
// The merchant's relayer settles it on Whitechain Sepolia and the gateway verifies the receipt
// on-chain before `pay()` resolves. The INR figure is a quoted equivalent (DEMO INR SETTLEMENT):
// no rupees move. Dependency-free; needs an EIP-1193 wallet (window.ethereum).

const WHITECHAIN = { id: 1874, hex: "0x752", name: "Whitechain Sepolia", rpc: "https://rpc.testnet.whitechain.io/", explorer: "https://explorer.testnet.whitechain.io" };
const USDT = "0xcedfb56113143d55b2358b8cfbb0deb5ad2f55a7";
const lower = (a) => String(a || "").toLowerCase();

export class OmenCheckoutError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class OmenCheckout {
  /** @param {{ gateway?: string, merchant: string, provider?: any }} o */
  constructor({ gateway = "", merchant, provider } = {}) {
    if (!merchant) throw new OmenCheckoutError("config", "merchant is required");
    this.gateway = gateway.replace(/\/$/, "");
    this.merchant = merchant;
    this.provider = provider || globalThis.ethereum;
  }

  async #api(path, body) {
    const r = await fetch(this.gateway + "/api" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new OmenCheckoutError(j.error || `http_${r.status}`, j.message || `Gateway error (HTTP ${r.status})`);
    return j;
  }

  /**
   * Charge the customer `inr` rupees' worth of test USDT for this merchant.
   * @param {{ inr: string, note?: string, acknowledgeRisk?: boolean }} order
   * @param {{ onStatus?: (s: string) => void }} [opts]
   * @returns {Promise<{ id, state, txHash, explorer, amount, token, inrPaise, inr: string }>}
   */
  async pay({ inr, note = "", acknowledgeRisk = false }, { onStatus = () => {} } = {}) {
    if (!this.provider) throw new OmenCheckoutError("no_wallet", "No EVM wallet found in this browser.");
    const cfg = await this.#api("/config");
    const m = cfg.merchants.find((x) => x.id === this.merchant);
    if (!m) throw new OmenCheckoutError("unknown_merchant", `Unknown merchant "${this.merchant}".`);
    if (!cfg.checkout || !cfg.gasless?.enabled) throw new OmenCheckoutError("checkout_off", "This gateway has no gasless checkout configured.");

    onStatus("connecting");
    const [payer] = await this.provider.request({ method: "eth_requestAccounts" });
    const qr = `upi://pay?pa=${encodeURIComponent(m.vpa)}&pn=${encodeURIComponent(m.name)}&am=${encodeURIComponent(inr)}&cu=INR${note ? `&tn=${encodeURIComponent(note)}` : ""}`;

    onStatus("quoting");
    let p = await this.#api("/payments", { qr, token: "USDT" });
    p = await this.#api(`/payments/${p.id}/risk`, {});
    if (p.state === "BLOCKED") throw new OmenCheckoutError("blocked", "The payment was blocked by the safety check.");
    p = await this.#api(`/payments/${p.id}/authorize`, { payer, acknowledgeRisk });
    const td = p.chain?.typedData;
    // Check every term ourselves before the wallet sees it.
    const msg = td?.message || {};
    if (!td || td.primaryType !== "ReceiveWithAuthorization" || td.domain.chainId !== WHITECHAIN.id || lower(td.domain.verifyingContract) !== USDT || lower(msg.from) !== lower(payer) || lower(msg.to) !== lower(cfg.checkout) || msg.value !== String(p.quote.tokenUnits))
      throw new OmenCheckoutError("bad_request", "The signature request doesn't match the quote. Nothing was signed.");

    onStatus("signing");
    await this.#switchChain();
    const typed = { ...td, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...td.types } };
    const signature = await this.provider.request({ method: "eth_signTypedData_v4", params: [payer, JSON.stringify(typed)] });

    onStatus("settling");
    p = await this.#api(`/payments/${p.id}/relay`, { signature });
    for (let i = 0; i < 45 && p.state === "SUBMITTED"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      p = await this.#api(`/payments/${p.id}`);
    }
    if (p.state !== "COMPLETED") throw new OmenCheckoutError("not_settled", `Payment ended as ${p.state}.`);
    onStatus("paid");
    return { id: p.id, state: p.state, txHash: p.txHash, explorer: `${WHITECHAIN.explorer}/tx/${p.txHash}`, amount: p.quote.tokenAmount, token: p.quote.token, inrPaise: p.quote.inrPaise, inr: p.payout?.label || "DEMO INR SETTLEMENT" };
  }

  async #switchChain() {
    const id = await this.provider.request({ method: "eth_chainId" });
    if (Number(id) === WHITECHAIN.id) return;
    try {
      await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: WHITECHAIN.hex }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await this.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: WHITECHAIN.hex, chainName: WHITECHAIN.name, nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: [WHITECHAIN.rpc], blockExplorerUrls: [WHITECHAIN.explorer] }] });
    }
  }
}
