import { ApiError } from './payments.js';

export const RATE_MAX_AGE_MS = 120_000;
export const QUOTE_TTL_MS = 60_000;
export const SIMULATION_LABEL = 'SIMULATED BTC → INR SETTLEMENT';
export const simulated = { settlement: 'SIMULATED', label: SIMULATION_LABEL };

export function ratePaise(value) {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new ApiError(503, 'rate_unavailable', 'The BTC reference rate is invalid.');
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (paise <= 0n || paise > 100_000_000_000_000n) throw new ApiError(503, 'rate_unavailable', 'The BTC reference rate is out of range.');
  return paise;
}
export const rateText = (paise) => `${BigInt(paise) / 100n}.${String(BigInt(paise) % 100n).padStart(2, '0')}`;
export const satsForPaise = (paise, perBtc) => (BigInt(paise) * 100_000_000n + BigInt(perBtc) - 1n) / BigInt(perBtc);

/** A configured demonstration rate is explicit, never silently substituted for live market data. */
export function createBtcInrRates({ demoRate = process.env.BTCINR_DEMO_INR_PER_BTC || '', fetchImpl = fetch, now = Date.now, apiKey = process.env.COINGECKO_API_KEY || '' } = {}) {
  const configured = demoRate ? ratePaise(demoRate) : null;
  let cached = null, pending = null, nextFetch = 0;
  return {
    async current() {
      if (configured) return { ...simulated, pair: 'BTC/INR', inrPerBtc: rateText(configured), source: 'configured-demo', fetchedAt: now(), stale: false, maxAgeMs: RATE_MAX_AGE_MS };
      if (!cached || now() >= nextFetch) {
        if (!pending) pending = (async () => {
          nextFetch = now() + 30_000;
          try {
            const response = await fetchImpl('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr&include_last_updated_at=true&precision=2', {
              signal: AbortSignal.timeout(8000), redirect: 'error', headers: { accept: 'application/json', ...(apiKey ? { 'x-cg-demo-api-key': apiKey } : {}) },
            });
            if (!response.ok) throw new Error('Reference rate unavailable');
            const body = await response.json();
            const paise = ratePaise(body?.bitcoin?.inr);
            const stamp = body?.bitcoin?.last_updated_at;
            if (!Number.isSafeInteger(stamp) || stamp <= 0 || stamp * 1000 > now() + 5000) throw new Error('Invalid rate timestamp');
            cached = { pair: 'BTC/INR', inrPerBtc: rateText(paise), source: 'coingecko', fetchedAt: stamp * 1000 };
          } catch {
            if (!cached) throw new ApiError(503, 'rate_unavailable', 'The BTC reference rate is unavailable. No quote or payment was created.');
          }
        })().finally(() => { pending = null; });
        await pending;
      }
      return { ...simulated, ...cached, stale: now() - cached.fetchedAt >= RATE_MAX_AGE_MS, maxAgeMs: RATE_MAX_AGE_MS };
    },
  };
}
