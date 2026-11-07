// Merchant ledger: a Blockhaven merchant's own device. Payments appear the moment the gateway
// confirms them on Whitechain; history and CSV export come from the merchant API; refunds are
// sent from the merchant's own payout wallet (the merchant pays that gas, never the customer).
import "./merchant.css";
import { io } from "socket.io-client";
import { erc20Abi, getAddress, keccak256, toBytes } from "viem";
import { wallet, whitechain } from "./pay/wallet.js";
import { USDT, txUrl } from "../shared/chains.js";
import { formatInr } from "../shared/upi.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const REFUND_ABI = [
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "merchants", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "payout", type: "address" }, { name: "active", type: "bool" }] },
  { type: "function", name: "orders", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "payer", type: "address" }, { name: "merchantId", type: "bytes32" }, { name: "amount", type: "uint128" }, { name: "refunded", type: "uint128" }] },
];

let cfg = null;
let merchant = null;
let key = "";
let sock = null;
let isPayout = false;
const rows = new Map();

const status = (text, cls = "") => {
  $("#m-status").className = `status ${cls}`;
  $("#m-status span:last-child").textContent = text;
};

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: `Bearer ${key}`, ...(opts.headers || {}) } });
  if (r.status === 401) throw new Error("That access key doesn't open this merchant's ledger.");
  if (!r.ok) throw new Error(`Gateway error (HTTP ${r.status}).`);
  return r;
}

function chime() {
  try {
    const a = new AudioContext();
    [0, 4, 7, 12].forEach((n, i) => {
      const o = a.createOscillator();
      const g = a.createGain();
      o.frequency.value = 523.25 * 2 ** (n / 12);
      g.gain.setValueAtTime(0.0001, a.currentTime + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.15, a.currentTime + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + i * 0.09 + 0.4);
      o.connect(g).connect(a.destination);
      o.start(a.currentTime + i * 0.09);
      o.stop(a.currentTime + i * 0.09 + 0.45);
    });
  } catch {
    /* no audio */
  }
}

function render(newId) {
  const list = [...rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  $("#list").innerHTML = list.length
    ? list
        .map((p) => {
          const real = p.mode === "testnet";
          const refundable = real && isPayout && p.state === "COMPLETED" && p.orderId;
          return `<li class="${p.id === newId ? "new" : ""}" data-id="${esc(p.id)}">
            <span class="time">${new Date(p.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span class="what"><b>${esc(p.note || "Payment")}</b> <span class="state ${esc(p.state)}">${esc(p.state)}</span> ${real ? `<span class="badge real">TESTNET CRYPTO</span>` : `<span class="badge demo">DEMO</span>`}
              <small>${p.payer ? `from ${esc(short(p.payer))}` : "DEMO player"}${p.relayed ? " · gasless" : ""}${p.txHash ? ` · <a href="${txUrl(p.txHash)}" target="_blank" rel="noopener">tx ${esc(short(p.txHash))} ↗</a>` : ""}${p.refunded ? ` · refunded ${esc(p.refunded)}` : ""}</small></span>
            <span class="amt"><b>${esc(p.amount)} ${esc(p.token)}</b><small>${formatInr(p.inrPaise)} quoted</small>${refundable ? `<br><button class="btn small ghost" data-refund="${esc(p.id)}">Refund</button>` : ""}</span>
          </li>`;
        })
        .join("")
    : `<li class="empty">No payments yet. When a courier pays at the stall, it lands here.</li>`;
  const today = new Date().toDateString();
  const done = list.filter((p) => p.state === "COMPLETED" && new Date(p.createdAt).toDateString() === today);
  $("#t-count").textContent = String(done.length);
  $("#t-inr").textContent = formatInr(done.reduce((n, p) => n + p.inrPaise, 0));
  const usdt = done.filter((p) => p.mode === "testnet").reduce((n, p) => n + BigInt(p.amountUnits || 0), 0n);
  $("#t-usdt").textContent = (Number(usdt) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
  $("#list").querySelectorAll("[data-refund]").forEach((b) => (b.onclick = () => refund(rows.get(b.dataset.refund), b)));
}

function flash(p) {
  const real = p.mode === "testnet";
  const f = $("#flash");
  f.hidden = false;
  f.innerHTML = `<div class="coin" aria-hidden="true">₹</div><div><h2>Paid: ${esc(p.note || "an order")}</h2>
    <p><b>${esc(p.amount)} ${esc(p.token)}</b> ${real ? `<span class="badge real">TESTNET CRYPTO PAYMENT</span> confirmed on Whitechain Sepolia${p.txHash ? ` · <a href="${txUrl(p.txHash)}" target="_blank" rel="noopener">view tx ↗</a>` : ""}` : `<span class="badge demo">DEMO</span> play credits, no blockchain`}</p>
    <p>${formatInr(p.inrPaise)} <span class="badge sim">DEMO INR SETTLEMENT</span> <small>quoted equivalent only; no rupees were sent to your bank</small></p></div>`;
  chime();
  document.title = `● Paid ${formatInr(p.inrPaise)} · ${merchant.name}`;
}

async function open(e) {
  e?.preventDefault();
  const id = $("#m-pick").value;
  merchant = cfg.merchants.find((m) => m.id === id);
  key = $("#m-key").value.trim();
  try {
    const { payments } = await (await api(`/api/merchant/${id}/payments`)).json();
    rows.clear();
    payments.forEach((p) => rows.set(p.id, p));
  } catch (err) {
    status(err.message, "off");
    return;
  }
  try {
    sessionStorage.setItem(`omen.mkey.${id}`, key);
  } catch {
    /* ignore */
  }
  history.replaceState(null, "", `?m=${id}`);
  $("#m-name").textContent = merchant.name;
  document.title = `${merchant.name} · Ledger`;
  $("#unlock").hidden = true;
  $("#board").hidden = false;
  render();
  sock?.close();
  sock = io("/merchant", { auth: { merchantId: id, key }, transports: ["websocket"] });
  sock.on("connect", () => status("Live: payments appear as they settle", "on"));
  sock.on("disconnect", () => status("Reconnecting…", "off"));
  sock.on("connect_error", (err) => status(err.message === "unauthorized" ? "Key refused" : "Can't reach the gateway", "off"));
  sock.on("payment", (p) => {
    const was = rows.get(p.id);
    rows.set(p.id, { ...was, ...p });
    if (p.state === "COMPLETED" && was?.state !== "COMPLETED") flash(p);
    render(p.id);
  });
}

async function connectWallet() {
  try {
    await wallet.connect();
    await wallet.ensureChain(whitechain);
    const [payout] = await wallet.pub.readContract({ address: cfg.checkout, abi: REFUND_ABI, functionName: "merchants", args: [keccak256(toBytes(merchant.id))] });
    isPayout = getAddress(payout) === wallet.address;
    $("#w-info").textContent = isPayout ? `Payout wallet ${short(wallet.address)} connected: refunds enabled.` : `${short(wallet.address)} isn't ${merchant.name}'s payout address (${short(payout)}), so it can't refund.`;
    render();
  } catch (err) {
    $("#w-info").textContent = err.shortMessage || err.message;
  }
}

async function refund(p, b) {
  const [, , amount, refunded] = await wallet.pub.readContract({ address: cfg.checkout, abi: REFUND_ABI, functionName: "orders", args: [p.orderId] });
  const left = amount - refunded;
  if (left <= 0n) return alert("This order is already fully refunded.");
  const human = (Number(left) / 1e6).toString();
  if (!confirm(`Refund ${human} test USDT to ${short(p.payer)}? Your wallet will ask you to approve exactly this amount, then send the refund (you pay the WBT gas).`)) return;
  b.disabled = true;
  try {
    const w = wallet.client();
    const ah = await w.writeContract({ address: USDT.address, abi: erc20Abi, functionName: "approve", args: [cfg.checkout, left] });
    await wallet.pub.waitForTransactionReceipt({ hash: ah });
    const rh = await w.writeContract({ address: cfg.checkout, abi: REFUND_ABI, functionName: "refund", args: [p.orderId, left] });
    const r = await wallet.pub.waitForTransactionReceipt({ hash: rh });
    if (r.status !== "success") throw new Error("The refund transaction reverted.");
    rows.set(p.id, { ...p, refunded: `${human} USDT (tx ${short(rh)})` });
    render();
  } catch (err) {
    alert(err.shortMessage || err.message);
    b.disabled = false;
  }
}

async function csv() {
  try {
    const blob = await (await api(`/api/merchant/${merchant.id}/payments?format=csv`)).blob();
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `omen-${merchant.id}-payments.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) {
    status(err.message, "off");
  }
}

(async () => {
  cfg = await (await fetch("/api/config")).json();
  const want = new URLSearchParams(location.search).get("m");
  $("#m-pick").innerHTML = cfg.merchants.map((m) => `<option value="${esc(m.id)}" ${m.id === want ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  $("#unlock").onsubmit = open;
  $("#csv").onclick = csv;
  $("#wallet").onclick = connectWallet;
  $("#wallet").hidden = !cfg.checkout;
  let saved = "";
  try {
    saved = sessionStorage.getItem(`omen.mkey.${$("#m-pick").value}`) || "";
  } catch {
    /* ignore */
  }
  if (saved) {
    $("#m-key").value = saved;
    open();
  }
})();
