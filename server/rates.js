// USDT → INR rate. Live from CoinGecko when reachable, cached for a minute; otherwise a fixed
// fallback that is labelled "fallback" in every quote so it's never mistaken for a market price.
import { config } from "./config.js";

let cache = null;

export async function usdtInr(fetchImpl = fetch, now = Date.now()) {
  if (cache && now - cache.at < 60_000) return cache.value;
  let value;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 4000);
    const res = await fetchImpl(config.rateUrl, { signal: c.signal, headers: { accept: "application/json" } }).finally(() => clearTimeout(t));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const n = Number((await res.json())?.tether?.inr);
    if (!(n > 50 && n < 200)) throw new Error("implausible rate"); // sanity bound for USDT/INR
    value = { rate: n.toFixed(4), source: "coingecko", at: now };
  } catch (e) {
    value = { rate: config.fallbackUsdtInr, source: "fallback", note: `Live rate unavailable (${e.message}); using a fixed demo rate.`, at: now };
  }
  cache = { at: now, value };
  return value;
}

export const _resetRateCache = () => (cache = null);
