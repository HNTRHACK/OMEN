import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dependency); real environment variables win.
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const e = process.env;
const addr = (v) => (/^0x[0-9a-fA-F]{40}$/.test(v || "") ? v : null);

export const config = {
  port: Number(e.PORT || 8787),
  dataDir: e.DATA_DIR || join(ROOT, "server", "data"),
  allowedOrigin: e.ALLOWED_ORIGIN || "", // only needed if the API is served from another origin
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
