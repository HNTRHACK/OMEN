// The tutorial payment's receipt chip: an explorer link only for a transaction the server
// confirmed on-chain; otherwise a SIMULATED label.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function showChaiReceipt(paid) {
  let el = document.getElementById("chai-receipt");
  if (!el) {
    el = document.createElement("aside");
    el.id = "chai-receipt";
    document.body.append(el);
  }
  el.className = paid.mode === "testnet" ? "live" : "sim";
  el.innerHTML =
    paid.mode === "testnet"
      ? `<b>ChaiPay · Whitechain Sepolia testnet</b><span>Order #${esc(paid.orderId)} · 0.25 test USDT in escrow</span><a href="${esc(paid.explorer)}" target="_blank" rel="noopener">View transaction ↗</a><small>Testnet tokens only. No real money.</small>`
      : `<b>SIMULATED PAYMENT</b><span>${esc(paid.reason)}</span><small>No transaction was sent. Testnet tokens only. No real money. Just for fun.</small>`;
  el.innerHTML += `<button type="button" aria-label="Close">×</button>`;
  el.querySelector("button").onclick = () => el.remove();
  return el;
}
