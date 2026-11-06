// Final Block step 4: the prediction booth panel. Reads markets from the owner-editable JSON and
// live pools from OmenPredictions on Whitechain Sepolia; stakes are signed in the player's wallet.
// Every screen says: Testnet tokens only. No real money. Just for fun.
import { formatUnits, parseUnits, erc20Abi } from "viem";
import { wallet, whitechain } from "../pay/wallet.js";
import { human } from "./gate.js";

export const LABEL = "Testnet tokens only. No real money. Just for fun.";
const ABI = [
  { type: "function", name: "optionTotal", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint8" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "stakeOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }, { type: "uint8" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "points", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "markets", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ name: "closesAt", type: "uint64" }, { name: "optionCount", type: "uint8" }, { name: "resolved", type: "bool" }, { name: "cancelled", type: "bool" }, { name: "winMask", type: "uint64" }, { name: "total", type: "uint256" }, { name: "winningTotal", type: "uint256" }] },
  { type: "function", name: "stake", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint8" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v) => Number(formatUnits(v, 6)).toLocaleString("en-IN", { maximumFractionDigits: 2 });

let cfg = null;
export async function loadMarkets() {
  if (!cfg) cfg = await fetch("./predictions/markets.json", { cache: "no-store" }).then((r) => r.json());
  return cfg;
}
export const boothName = (id) => cfg?.booths.find((b) => b.id === id)?.name || id;

async function api(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error });
  return j;
}

export function createBooths({ onClose = () => {} } = {}) {
  const el = document.createElement("section");
  el.id = "booth";
  el.hidden = true;
  el.setAttribute("aria-live", "polite");
  document.body.append(el);
  let current = null;

  const close = () => {
    el.hidden = true;
    current = null;
    onClose();
  };

  async function open(id) {
    current = id;
    el.hidden = false;
    el.innerHTML = `<div class="booth-card"><p class="loading">Opening the booth…</p></div>`;
    try {
      await render();
    } catch (e) {
      el.innerHTML = `<div class="booth-card"><p class="err">${esc(e.message)}</p><button class="btn small" id="b-close">Close</button></div>`;
      el.querySelector("#b-close").onclick = close;
    }
  }

  async function render(msg = "") {
    const c = await loadMarkets();
    const b = c.booths.find((x) => x.id === current);
    const st = await api("/api/predictions/status").catch(() => ({ contract: null, human: null }));
    const contract = st.contract;
    const me = st.human;
    const addr = me?.wallet;
    const closes = new Date(c.closesAt);
    const head = `
      <header class="booth-head"><h2>${esc(b.name)}</h2><button class="booth-x" type="button" aria-label="Close">×</button></header>
      <p class="booth-label">${LABEL}</p>
      <p class="booth-blurb">${esc(b.blurb)}</p>`;

    if (b.signal) return renderSignal(b, head, st, msg);

    let who = "";
    if (!me) who = `<p class="err">Only World ID-verified humans can predict. ${human.guest ? "You're playing UNVERIFIED (dev)." : ""}</p>`;
    else if (!addr) who = `<p class="err">Link a wallet to your World ID first (reload and finish the gate's wallet step).</p>`;
    else if (!contract) who = `<p class="fine">The booths open once the testnet contract is deployed. Here's what you'll be predicting.</p>`;
    else if (!st.verifiedOnChain) who = `<p class="fine">Your wallet isn't registered with the booth contract yet.</p><button class="btn small" id="b-reg" type="button">Register my verified wallet</button>`;

    // live pools, read from the chain
    const live = contract && addr && st.verifiedOnChain;
    const read = (functionName, args) => wallet.pub.readContract({ address: contract, abi: ABI, functionName, args });
    const rows = [];
    let balance = null;
    if (contract) {
      if (live) balance = c.mode === "points" ? await read("points", [addr]).catch(() => null) : await wallet.usdtBalance().catch(() => null);
      for (const m of b.markets) {
        if (!m.marketId) {
          rows.push({ m, totals: null });
          continue;
        }
        const [info, totals, mine, claim] = await Promise.all([
          read("markets", [BigInt(m.marketId)]).catch(() => null),
          Promise.all(m.options.map((_, i) => read("optionTotal", [BigInt(m.marketId), i]).catch(() => 0n))),
          live ? Promise.all(m.options.map((_, i) => read("stakeOf", [BigInt(m.marketId), addr, i]).catch(() => 0n))) : null,
          live ? read("claimable", [BigInt(m.marketId), addr]).catch(() => 0n) : 0n,
        ]);
        rows.push({ m, info, totals, mine, claim });
      }
    } else for (const m of b.markets) rows.push({ m, totals: null });

    const unit = c.mode === "points" ? "pts" : "test USDT";
    el.innerHTML = `<div class="booth-card">${head}
      ${who}
      ${balance !== null ? `<p class="booth-bal">You have <b>${fmt(balance)}</b> ${unit}${c.mode === "points" ? " (free testnet points)" : ""}. Closes ${esc(closes.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }))}.</p>` : ""}
      ${msg ? `<p class="${msg.startsWith("✓") ? "ok" : "err"}">${esc(msg)}</p>` : ""}
      <div class="booth-markets">${rows.map((r, k) => market(r, k, live, unit)).join("")}</div>
      <p class="booth-label">${LABEL}</p></div>`;
    el.querySelector(".booth-x").onclick = close;
    el.querySelector("#b-reg")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Registering on Whitechain Sepolia…";
      try {
        await api("/api/predictions/register", {});
        await render("✓ Registered. You can predict now.");
      } catch (err) {
        await render(err.message);
      }
    });
    for (const f of el.querySelectorAll("form[data-m]")) f.onsubmit = (e) => (e.preventDefault(), stake(c, rows[Number(f.dataset.m)].m, f));
    for (const btn of el.querySelectorAll("[data-claim]")) btn.onclick = () => claim(contract, Number(btn.dataset.claim));
  }

  function market({ m, info, totals, mine, claim }, k, live, unit) {
    const sum = totals ? totals.reduce((a, b) => a + b, 0n) : 0n;
    const settled = info && (info.resolved || info.cancelled);
    const closed = info && Number(info.closesAt) * 1000 <= Date.now();
    const won = (i) => info?.resolved && (BigInt(info.winMask) >> BigInt(i)) & 1n;
    return `<form class="booth-market" data-m="${k}">
      <h3>${esc(m.question)}</h3>
      ${!m.marketId ? `<p class="fine">Not on-chain yet.</p>` : ""}
      <ul>${m.options
        .map((o, i) => {
          const pct = sum ? Number((totals[i] * 1000n) / sum) / 10 : 0;
          return `<li${won(i) ? ' class="won"' : ""}><label><input type="radio" name="o" value="${i}" ${live && !settled && !closed ? "" : "disabled"} ${i === 0 ? "required" : ""}> ${esc(o)}</label>
            <span class="bar"><i style="width:${pct}%"></i></span><small>${totals ? `${fmt(totals[i])}${mine?.[i] ? ` · yours ${fmt(mine[i])}` : ""}` : ""}</small></li>`;
        })
        .join("")}</ul>
      ${live && !settled && !closed ? `<div class="booth-stake"><input name="a" inputmode="decimal" placeholder="Amount (${unit})" required><button class="btn small" type="submit">Stake</button></div>` : ""}
      ${closed && !settled ? `<p class="fine">Closed. Waiting for the result.</p>` : ""}
      ${info?.cancelled ? `<p class="fine">Cancelled: stakes are refundable.</p>` : ""}
      ${claim ? `<button class="btn small" type="button" data-claim="${m.marketId}">Claim ${fmt(claim)} ${unit}</button>` : ""}
    </form>`;
  }

  async function stake(c, m, form) {
    const option = Number(new FormData(form).get("o"));
    let amount;
    try {
      amount = parseUnits(String(new FormData(form).get("a")).trim(), 6);
      if (amount <= 0n) throw new Error();
    } catch {
      return render("Enter an amount like 10 or 2.5.");
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Confirm in your wallet…";
    try {
      if (!wallet.address) await wallet.connect();
      await wallet.ensureChain(whitechain);
      if (wallet.address !== human.current?.wallet) throw new Error("Switch your wallet to the one linked to your World ID.");
      const w = wallet.client();
      if (c.mode !== "points") {
        const token = await wallet.pub.readContract({ address: c.contract, abi: ABI, functionName: "token" });
        const allowance = await wallet.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [wallet.address, c.contract] });
        if (allowance < amount) await wallet.pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [c.contract, amount] }) });
      }
      const hash = await w.writeContract({ address: c.contract, abi: ABI, functionName: "stake", args: [BigInt(m.marketId), option, amount] });
      const r = await wallet.pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("The stake reverted.");
      await render(`✓ Staked on “${m.options[option]}”. Tx ${hash.slice(0, 10)}… on Whitechain Sepolia (testnet).`);
    } catch (e) {
      await render(e.shortMessage || e.message);
    }
  }

  async function claim(contract, marketId) {
    try {
      const hash = await wallet.client().writeContract({ address: contract, abi: ABI, functionName: "claim", args: [BigInt(marketId)] });
      await wallet.pub.waitForTransactionReceipt({ hash });
      await render("✓ Claimed (testnet).");
    } catch (e) {
      await render(e.shortMessage || e.message);
    }
  }

  async function renderSignal(b, head, st, msg) {
    const t = await api("/api/predictions/signals").catch(() => ({ counts: b.options.map(() => 0), total: 0 }));
    el.innerHTML = `<div class="booth-card">${head}
      <p class="booth-note">A fun signal only. No stakes, no prizes — and no sponsor rewards anyone for it.</p>
      ${!st.human ? `<p class="err">Only World ID-verified humans can back a statement.</p>` : ""}
      ${msg ? `<p class="ok">${esc(msg)}</p>` : ""}
      <ul class="booth-signal">${b.options
        .map((o, i) => `<li${st.signal === i ? ' class="mine"' : ""}><span>${esc(o)}</span><span class="bar"><i style="width:${t.total ? (t.counts[i] / t.total) * 100 : 0}%"></i></span><small>${t.counts[i]}</small>${st.human ? `<button class="btn small ghost" type="button" data-sig="${i}">${st.signal === i ? "Backed" : "Back this"}</button>` : ""}</li>`)
        .join("")}</ul>
      <p class="booth-label">${LABEL}</p></div>`;
    el.querySelector(".booth-x").onclick = close;
    for (const btn of el.querySelectorAll("[data-sig]"))
      btn.onclick = async () => {
        try {
          await api("/api/predictions/signal", { option: Number(btn.dataset.sig) });
          await render("✓ Backed. Thanks for the signal.");
        } catch (e) {
          await render(e.message);
        }
      };
  }

  return { open, close, get isOpen() { return !el.hidden; } };
}
