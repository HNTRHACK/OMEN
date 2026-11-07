// Human gate server: proofs only count after World's verify API says so; one nullifier = one
// player; one wallet = one player; a wallet is linked only with its own signature.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { createFinalBlock, walletMessage } from "../server/final-block.js";

const config = { appId: "app_test", rpId: "rp_test", signingKey: "11".repeat(32), environment: "staging", allowGuest: false };
const mem = () => {
  const db = { humans: {}, sessions: {}, wallets: {} };
  return { db, save() {} };
};
const proof = (nullifier) => ({ protocol_version: "3.0", nonce: "n", action: "play-omen", environment: "staging", responses: [{ identifier: "orb", nullifier, proof: "0x", merkle_root: "0x1" }] });

async function boot(worldSays = () => ({ success: true })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const j = worldSays(JSON.parse(init.body));
    return { ok: j.success, json: async () => j };
  };
  const final = createFinalBlock({ config, store: mem(), fetchImpl, signRequestImpl: () => ({ sig: "0xsig", nonce: "0xnonce", createdAt: 1, expiresAt: 2 }) });
  const server = createServer(async (req, res) => (await final(req, res)) || res.writeHead(404).end());
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = { c: "" };
  const call = async (path, body, cookie = jar.c) => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get("set-cookie");
    if (set) jar.c = set.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
  return { call, calls, jar, close: () => server.close() };
}

test("rp-context is signed by the server for action play-omen", async () => {
  const t = await boot();
  const r = await t.call("/api/world/rp-context", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.action, "play-omen");
  assert.deepEqual(r.body.rp_context, { rp_id: "rp_test", nonce: "0xnonce", created_at: 1, expires_at: 2, signature: "0xsig" });
  t.close();
});

test("a proof World rejects creates no session", async () => {
  const t = await boot(() => ({ success: false, code: "invalid_proof", detail: "bad" }));
  const r = await t.call("/api/verify", { result: proof("123") });
  assert.equal(r.status, 400);
  assert.equal((await t.call("/api/human")).body.human, null);
  t.close();
});

test("verified once → session; same nullifier again → same player; staging never says VERIFIED HUMAN", async () => {
  const t = await boot();
  const a = await t.call("/api/verify", { result: proof("12345") });
  assert.equal(a.status, 200);
  assert.equal(t.calls[0].url, "https://developer.world.org/api/v4/verify/rp_test");
  assert.equal(a.body.returning, false);
  assert.match(a.body.human.badge, /STAGING/);
  const me = await t.call("/api/human");
  assert.equal(me.body.human.playerId, a.body.human.playerId);
  t.jar.c = "";
  const b = await t.call("/api/verify", { result: proof("0x3039") }); // same number in hex
  assert.equal(b.body.returning, true);
  assert.equal(b.body.human.playerId, a.body.human.playerId);
  t.close();
});

test("wrong environment / action is refused before calling World", async () => {
  const t = await boot();
  assert.equal((await t.call("/api/verify", { result: { ...proof("1"), environment: "production" } })).status, 400);
  assert.equal((await t.call("/api/verify", { result: { ...proof("1"), action: "other" } })).status, 400);
  assert.equal(t.calls.length, 0);
  t.close();
});

test("wallet links only with its own signature, and only to one human", async () => {
  const t = await boot();
  const acct = privateKeyToAccount("0x" + "22".repeat(32));
  assert.equal((await t.call("/api/human/wallet", { address: acct.address, message: "x", signature: "0x" })).status, 401);
  const a = await t.call("/api/verify", { result: proof("777") });
  const message = walletMessage(a.body.human.playerId, acct.address);
  const other = privateKeyToAccount("0x" + "33".repeat(32));
  const forged = await t.call("/api/human/wallet", { address: acct.address, message, signature: await other.signMessage({ message }) });
  assert.equal(forged.status, 400);
  const ok = await t.call("/api/human/wallet", { address: acct.address, message, signature: await acct.signMessage({ message }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.human.wallet, acct.address);
  // a second human can't take the same wallet
  t.jar.c = "";
  const b = await t.call("/api/verify", { result: proof("888") });
  const m2 = walletMessage(b.body.human.playerId, acct.address);
  assert.equal((await t.call("/api/human/wallet", { address: acct.address, message: m2, signature: await acct.signMessage({ message: m2 }) })).status, 409);
  t.close();
});
