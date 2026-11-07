// Market data for the village's crypto collectibles, from CoinGecko, cached by the backend.
//
// CoinGecko's free API is rate-limited (we hit 429 after ~5 quick calls while building this), so:
//   - one batched /coins/markets call per currency (USD, INR) covers price, 24 h change and
//     ATH/ATL for every coin; cached 5 min;
//   - a coin's 30-day chart is fetched only when its panel opens; cached 30 min;
//   - concurrent requests share one in-flight fetch;
//   - on failure we serve the last good data marked `stale` with its age, and never invent prices.
// Set COINGECKO_API_KEY (a free "demo" key) for higher limits.

export const COINS = {
  btc: {
    id: "bitcoin",
    launch: { date: "2009-01-03", label: "Genesis block mined", source: "coingecko" },
    about: "The first cryptocurrency: a peer-to-peer electronic cash system secured by proof-of-work mining, with a fixed supply cap of 21 million coins.",
  },
  eth: {
    id: "ethereum",
    launch: { date: "2015-07-30", label: "Mainnet genesis block (Frontier)", source: "coingecko" },
    about: "A programmable blockchain. Smart contracts run on it, and ETH pays for the computation (gas). Many tokens, including stablecoins, live on Ethereum and chains built like it.",
  },
  sol: {
    id: "solana",
    launch: { date: "2020-03", label: "Mainnet Beta launched (March 2020)", source: "omen" },
    about: "A high-throughput smart-contract blockchain aiming for fast, low-fee transactions. SOL pays its fees and secures it through staking.",
  },
  usdt: {
    id: "tether",
    launch: { date: "2014-10", label: "First USDT tokens issued (October 2014)", source: "omen" },
    about: "A stablecoin: a token meant to stay worth one US dollar, backed by reserves held by its issuer, Tether. OMEN's checkout settles in Whitechain's test USDT, which has no monetary value.",
  },
  usdc: {
    id: "usd-coin",
    launch: { date: "2018-09", label: "Launched (September 2018)", source: "omen" },
    about: "A US-dollar stablecoin issued by Circle, redeemable one-for-one for dollars and backed by cash and short-term US Treasuries.",
  },
  wbt: {
    id: "whitebit",
    launch: { date: null, label: "Launch date not published by CoinGecko", source: "coingecko" },
    about: "WhiteBIT Coin, the token of the WhiteBIT ecosystem. It is also the native gas token of Whitechain, where OMEN's checkout runs; the testnet WBT used in OMEN has no monetary value.",
  },
};

const TTL_MARKETS = 5 * 60_000;
const TTL_CHART = 30 * 60_000;

export function createMarket({ fetchImpl = fetch, now = () => Date.now(), apiKey = process.env.COINGECKO_API_KEY || "" } = {}) {
  const cache = new Map(); // key → { at, value }
  const inflight = new Map();
  const base = "https://api.coingecko.com/api/v3";

  async function get(path) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    try {
      const res = await fetchImpl(base + path, { signal: c.signal, headers: { accept: "application/json", ...(apiKey ? { "x-cg-demo-api-key": apiKey } : {}) } });
      if (!res.ok) throw new Error(res.status === 429 ? "CoinGecko rate limit" : `CoinGecko HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /** Fresh cached value, else one shared fetch; on failure the last good value marked stale. */
  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return { ...hit, stale: false };
    if (!inflight.has(key))
      inflight.set(
        key,
        load()
          .then((value) => {
            const v = { at: now(), value };
            cache.set(key, v);
            return { ...v, stale: false };
          })
          .catch((err) => {
            if (hit) return { ...hit, stale: true, error: err.message };
            throw err;
          })
          .finally(() => inflight.delete(key)),
      );
    return inflight.get(key);
  }

  const ids = Object.values(COINS).map((c) => c.id).join(",");
  const markets = (vs) =>
    cached(`markets:${vs}`, TTL_MARKETS, async () => {
      const rows = await get(`/coins/markets?vs_currency=${vs}&ids=${ids}&price_change_percentage=24h`);
      if (!Array.isArray(rows)) throw new Error("CoinGecko returned an unexpected response");
      return Object.fromEntries(rows.map((r) => [r.id, r]));
    });

  async function coin(sym) {
    const meta = COINS[sym];
    if (!meta) throw Object.assign(new Error("Unknown coin."), { status: 404, code: "unknown_coin" });
    const [usd, inr] = await Promise.all([markets("usd"), markets("inr")]);
    const u = usd.value[meta.id];
    const i = inr.value[meta.id];
    if (!u || !i) throw Object.assign(new Error("CoinGecko didn't return this coin."), { status: 502, code: "missing" });
    let chart = null;
    try {
      const ch = await cached(`chart:${meta.id}`, TTL_CHART, async () => {
        const d = await get(`/coins/${meta.id}/market_chart?vs_currency=usd&days=30&interval=daily`);
        if (!Array.isArray(d?.prices)) throw new Error("bad chart");
        return d.prices.map(([t, p]) => [t, Number(p.toPrecision(6))]);
      });
      chart = { points: ch.value, stale: ch.stale, at: ch.at };
    } catch (e) {
      chart = { points: null, error: e.message };
    }
    const stale = usd.stale || inr.stale;
    return {
      sym,
      id: meta.id,
      name: u.name,
      symbol: String(u.symbol).toUpperCase(),
      image: u.image,
      launch: meta.launch,
      about: meta.about,
      price: { usd: u.current_price, inr: i.current_price },
      change24h: u.price_change_percentage_24h,
      ath: { usd: u.ath, inr: i.ath, date: u.ath_date },
      atl: { usd: u.atl, inr: i.atl, date: u.atl_date },
      lastUpdated: u.last_updated, // CoinGecko's own timestamp for the price
      fetchedAt: Math.min(usd.at, inr.at), // when OMEN last got it
      stale,
      staleReason: stale ? usd.error || inr.error : undefined,
      chart,
      source: "CoinGecko",
    };
  }

  return { coin };
}
