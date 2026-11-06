// DEMO credits: a play-money ledger that lives only in this browser. No chain, no value.
// Every balance, transfer, swap and payment made with it is labelled DEMO in the UI.

const KEY = "omen.demo.v1";
export const DEMO_START = 1_000_000_00n; // 1,000,000 credits, 2 decimals
// Fixed play rates for demo swaps. Not market prices.
export const DEMO_ASSETS = {
  DEMO: { decimals: 2, label: "DEMO credits", perDemo: 1 },
  dUSDT: { decimals: 6, label: "Demo USDT", perDemo: 88 }, // 1 dUSDT = 88 DEMO
  dWBT: { decimals: 18, label: "Demo WBT", perDemo: 2400 },
};

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s?.bal) return { bal: Object.fromEntries(Object.entries(s.bal).map(([k, v]) => [k, BigInt(v)])), log: s.log || [] };
  } catch {
    /* storage blocked or corrupt: start fresh */
  }
  return { bal: { DEMO: DEMO_START, dUSDT: 0n, dWBT: 0n }, log: [] };
}

let st = read();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ bal: Object.fromEntries(Object.entries(st.bal).map(([k, v]) => [k, v.toString()])), log: st.log.slice(0, 100) }));
  } catch {
    /* ignore */
  }
}

const unitsOf = (asset, text) => {
  const d = DEMO_ASSETS[asset].decimals;
  const s = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Enter a positive number.");
  const [i, f = ""] = s.split(".");
  if (f.length > d) throw new Error(`At most ${d} decimals for ${asset}.`);
  const u = BigInt(i) * 10n ** BigInt(d) + BigInt((f + "0".repeat(d)).slice(0, d) || "0");
  if (u <= 0n) throw new Error("Enter more than zero.");
  return u;
};

export const demo = {
  balances: () => ({ ...st.bal }),
  log: () => st.log.slice(),
  spend(asset, units, entry) {
    if ((st.bal[asset] ?? 0n) < units) throw new Error(`Not enough ${asset}.`);
    st.bal[asset] -= units;
    st.log.unshift({ at: Date.now(), asset, units: (-units).toString(), ...entry });
    save();
  },
  /** Put credits back (a DEMO payment the gateway didn't complete). */
  refund(asset, units, ref) {
    st.bal[asset] = (st.bal[asset] ?? 0n) + units;
    st.log.unshift({ at: Date.now(), asset, units: units.toString(), kind: "refund", ref });
    save();
  },
  transfer(asset, to, amountText) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to) && !/^[\w.-]+@[\w.-]+$/.test(to)) throw new Error("Send to a wallet address or a UPI-style name.");
    const u = unitsOf(asset, amountText);
    demo.spend(asset, u, { kind: "transfer", to });
    return u;
  },
  swap(from, to, amountText) {
    if (from === to) throw new Error("Pick two different assets.");
    const a = DEMO_ASSETS[from];
    const b = DEMO_ASSETS[to];
    const u = unitsOf(from, amountText);
    if ((st.bal[from] ?? 0n) < u) throw new Error(`Not enough ${from}.`);
    // value in DEMO-hundredths, then into the target's units (rounded down, in the house's favour)
    const valueCents = (u * BigInt(a.perDemo) * 100n) / 10n ** BigInt(a.decimals);
    const out = (valueCents * 10n ** BigInt(b.decimals)) / (BigInt(b.perDemo) * 100n);
    if (out <= 0n) throw new Error("That's too small to swap.");
    st.bal[from] -= u;
    st.bal[to] = (st.bal[to] ?? 0n) + out;
    st.log.unshift({ at: Date.now(), kind: "swap", asset: from, units: (-u).toString(), to, outUnits: out.toString() });
    save();
    return out;
  },
  reset() {
    st = { bal: { DEMO: DEMO_START, dUSDT: 0n, dWBT: 0n }, log: [] };
    save();
  },
};
