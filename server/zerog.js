// 0G inference. Two real modes, never a fake one:
//   router  OpenAI-compatible 0G Compute Router (API key). Request ID from the response.
//   broker  @0gfoundation/0g-compute-ts-sdk straight to a provider with a funded wallet; the chat ID
//           comes from the ZG-Res-Key header and each answer is checked with processResponse().
// With neither configured, `infer` returns null and the caller reports "rules only".

import { config } from "./config.js";

const withTimeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error(`timed out after ${ms} ms`)), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

export function zgStatus() {
  const z = config.zg;
  return { mode: z.mode, configured: z.mode === "router" ? !!z.apiKey : z.mode === "broker" ? !!(z.privateKey && z.provider) : false, baseUrl: z.mode === "router" ? z.baseUrl : undefined, model: z.model || undefined };
}

async function viaRouter(messages, fetchImpl = fetch) {
  const z = config.zg;
  const t0 = Date.now();
  const to = withTimeout(z.timeoutMs);
  try {
    const res = await fetchImpl(`${z.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${z.apiKey}` },
      body: JSON.stringify({ model: z.model || undefined, messages, temperature: 0, max_tokens: 300 }),
      signal: to.signal,
    });
    if (!res.ok) throw new Error(`router HTTP ${res.status}`);
    const data = await res.json();
    const requestId = res.headers.get("zg-res-key") || res.headers.get("x-request-id") || data.id || null;
    if (!requestId) throw new Error("router response had no request ID");
    return { content: data.choices?.[0]?.message?.content ?? "", requestId, model: data.model || z.model, provider: "0g-router", verified: null, latencyMs: Date.now() - t0 };
  } finally {
    to.done();
  }
}

let brokerP = null;
async function broker() {
  if (!brokerP)
    brokerP = (async () => {
      const [{ ethers }, sdk] = await Promise.all([import("ethers"), import("@0gfoundation/0g-compute-ts-sdk")]);
      const wallet = new ethers.Wallet(config.zg.privateKey, new ethers.JsonRpcProvider(config.zg.rpc));
      return sdk.createZGComputeNetworkBroker(wallet);
    })().catch((e) => {
      brokerP = null;
      throw e;
    });
  return brokerP;
}

async function viaBroker(messages) {
  const z = config.zg;
  const t0 = Date.now();
  const b = await broker();
  const { endpoint, model } = await b.inference.getServiceMetadata(z.provider);
  const headers = await b.inference.getRequestHeaders(z.provider);
  const to = withTimeout(z.timeoutMs);
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 300 }),
      signal: to.signal,
    });
    if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
    const data = await res.json();
    const requestId = res.headers.get("ZG-Res-Key") || data.id || null;
    let verified = null;
    if (requestId) verified = !!(await b.inference.processResponse(z.provider, requestId).catch(() => false));
    return { content: data.choices?.[0]?.message?.content ?? "", requestId, model, provider: `0g-provider:${z.provider}`, verified, latencyMs: Date.now() - t0 };
  } finally {
    to.done();
  }
}

/** Run a chat completion on 0G. Returns null when 0G isn't configured; throws on failure. */
export async function infer(messages, deps = {}) {
  const s = zgStatus();
  if (!s.configured) return null;
  return config.zg.mode === "broker" ? viaBroker(messages) : viaRouter(messages, deps.fetch);
}
