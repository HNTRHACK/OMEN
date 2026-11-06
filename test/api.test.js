import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../server/index.js";
import { createPaymentService } from "../server/payments.js";
import { Store } from "../server/store.js";
import { merchantQr, MERCHANTS } from "../shared/merchants.js";
import { config } from "../server/config.js";
import { infer } from "../server/zerog.js";

let server, base;
before(async () => {
  const service = createPaymentService({
    store: new Store(null),
    rates: async () => ({ rate: "88.00", source: "test" }),
    infer: async () => null,
    verify: async () => ({ blockNumber: "1", confirmations: 1 }),
    checkoutConfigured: () => false,
  });
  server = createServer(createApp({ service, publicConfig: () => ({ ok: 1 }) }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, headers = { "content-type": "application/json" }) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("full DEMO flow over HTTP", async () => {
  const qr = merchantQr(MERCHANTS[0], MERCHANTS[0].items[1]);
  let p = await (await post("/api/payments", { qr, token: "DEMO" })).json();
  assert.equal(p.state, "QUOTED");
  p = await (await post(`/api/payments/${p.id}/risk`, {})).json();
  assert.equal(p.risk.ai.status, "off");
  p = await (await post(`/api/payments/${p.id}/authorize`, {})).json();
  p = await (await post(`/api/payments/${p.id}/submit`, { demoRef: "x" })).json();
  assert.equal(p.state, "COMPLETED");
  const g = await (await fetch(`${base}/api/payments/${p.id}`)).json();
  assert.equal(g.payout.simulated, true);
});

test("validation errors come back as JSON with codes", async () => {
  const r = await post("/api/payments", { qr: "hello", token: "DEMO" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "not_upi");
  const off = await post("/api/payments", { qr: merchantQr(MERCHANTS[0], MERCHANTS[0].items[0]), token: "USDT" });
  assert.equal(off.status, 503);
});

test("rejects non-JSON, malformed JSON, oversized bodies and unknown ids", async () => {
  assert.equal((await post("/api/payments", "qr=x", { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("/api/payments", "{bad")).status, 400);
  assert.equal((await post("/api/payments", "[1]")).status, 400);
  const huge = await post("/api/payments", JSON.stringify({ qr: "x".repeat(20_000) })).catch(() => ({ status: 413 }));
  assert.equal(huge.status, 413);
  assert.equal((await fetch(`${base}/api/payments/00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/api/payments/../../etc/passwd`)).status, 404);
});

test("responses carry no-store and nosniff headers", async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("access-control-allow-origin"), null, "no CORS by default");
});

test("static serving refuses path traversal", async () => {
  const r = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(r.status, 200);
});

test("0G router: request ID is taken from the response; missing ID or HTTP errors throw", async () => {
  const saved = { ...config.zg };
  Object.assign(config.zg, { mode: "router", apiKey: "k", model: "m", baseUrl: "https://router.test/v1" });
  try {
    const mk = (status, body, headers = {}) => async (url, init) => {
      assert.equal(url, "https://router.test/v1/chat/completions");
      assert.equal(init.headers.Authorization, "Bearer k");
      return new Response(JSON.stringify(body), { status, headers });
    };
    const ok = await infer([], { fetch: mk(200, { id: "chatcmpl-9", model: "m", choices: [{ message: { content: "{}" } }] }, { "zg-res-key": "zg-777" }) });
    assert.equal(ok.requestId, "zg-777");
    assert.equal(ok.provider, "0g-router");
    const fromBody = await infer([], { fetch: mk(200, { id: "chatcmpl-9", choices: [{ message: { content: "{}" } }] }) });
    assert.equal(fromBody.requestId, "chatcmpl-9");
    await assert.rejects(infer([], { fetch: mk(200, { choices: [] }) }), /no request ID/);
    await assert.rejects(infer([], { fetch: mk(401, {}) }), /HTTP 401/);
  } finally {
    Object.assign(config.zg, saved);
  }
});
