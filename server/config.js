import { join } from "node:path";
import { ROOT } from './env.js';
export { ROOT } from './env.js';

const e = process.env;
const addr = (v) => (/^0x[0-9a-fA-F]{40}$/.test(v || "") ? v : null);

export const config = {
  databaseUrl: e.DATABASE_URL || '',
  worldId: {
    environment: e.WORLD_ID_ENVIRONMENT || 'production',
    clientId: e.WORLD_ID_CLIENT_ID || '',
    clientSecret: e.WORLD_ID_CLIENT_SECRET || '',
    redirectUri: e.WORLD_ID_REDIRECT_URI || '',
  },
  port: Number(e.PORT || 8787),
  dataDir: e.DATA_DIR || join(ROOT, "server", "data"),
  allowedOrigin: e.ALLOWED_ORIGIN || "", // only needed if the API is served from another origin
  // Behind a hosting proxy every request comes from the proxy; trust X-Forwarded-For only then.
  trustProxy: e.TRUST_PROXY === "1",
  quoteTtlMs: Number(e.QUOTE_TTL_SECONDS || 120) * 1000,

  whitechainRpc: e.WHITECHAIN_RPC || "https://rpc.testnet.whitechain.io/",
  checkoutAddress: addr(e.CHECKOUT_ADDRESS),
  minConfirmations: Number(e.MIN_CONFIRMATIONS || 1),
  // Gasless checkout relayer: a SERVER-ONLY testnet key holding a little WBT for gas.
  relayerKey: /^0x[0-9a-fA-F]{64}$/.test(e.RELAYER_PRIVATE_KEY || "") ? e.RELAYER_PRIVATE_KEY : null,
  relayerMaxPerHour: Number(e.RELAYER_MAX_PER_HOUR || 60),
  relayerMinWei: BigInt(Math.round(Number(e.RELAYER_MIN_WBT || 0.002) * 1e9)) * 1_000_000_000n,

  // INR price source. CoinGecko's public API, with a clearly labelled fixed fallback.
  rateUrl: e.RATE_URL || "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr",
  fallbackUsdtInr: e.FALLBACK_USDT_INR || "88.00",

  // 0G inference. "router": OpenAI-compatible 0G Compute Router with an API key.
  //               "broker": direct provider access via @0gfoundation/0g-compute-ts-sdk with a funded key,
  //                         which also verifies each response (processResponse).
  zg: {
    mode: e.ZG_MODE || (e.ZG_PRIVATE_KEY ? "broker" : e.ZG_API_KEY ? "router" : "off"),
    apiKey: e.ZG_API_KEY || "",
    baseUrl: (e.ZG_BASE_URL || "https://router-api-testnet.integratenetwork.work/v1").replace(/\/$/, ""),
    model: e.ZG_MODEL || "",
    privateKey: e.ZG_PRIVATE_KEY || "",
    provider: addr(e.ZG_PROVIDER),
    rpc: e.ZG_RPC || "https://evmrpc-testnet.0g.ai",
    timeoutMs: Number(e.ZG_TIMEOUT_MS || 15000),
  },
};
