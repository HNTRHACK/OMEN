// Prediction booths, server half: verified human + linked wallet → the owner key marks that wallet
// verified on-chain (once); problem-statement signals are one per human and never a bet.
// The on-chain part runs against a local anvil (chain 1874) when PREDICTIONS_TEST_RPC is set, e.g.
//   anvil --chain-id 1874 --port 8546 & PREDICTIONS_TEST_RPC=http://127.0.0.1:8546 node --test test/final-predictions.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, defineChain, zeroAddress } from "viem";

const RPC = process.env.PREDICTIONS_TEST_RPC;
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil's public dev key #0
const player = privateKeyToAccount("0x" + "55".repeat(32));

async function boot(env = {}) {
  Object.assign(process.env, env);
  const { createFinalBlock, walletMessage } = await import("../server/final-block.js");
  const { mountFinalRoutes } = await import("../server/final-routes.js?" + Math.random());
  const config = { appId: "app_t", rpId: "rp_t", signingKey: "11".repeat(32), environment: "staging", chaipayUrl: "http://x" };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ success: true }) });
  const final = createFinalBlock({ config, store: { db: { humans: {}, sessions: {}, wallets: {} }, save() {} }, fetchImpl, signRequestImpl: () => ({}) });
  mountFinalRoutes(final, { fetchImpl });
  const server = createServer(async (req, res) => (await final(req, res)) || res.writeHead(404).end());
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { ...(body ? { "content-type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
    if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, body: await r.json() };
  };
  const login = async (n) => {
    cookie = "";
    const v = await call("/api/verify", { result: { action: "play-omen", environment: "staging", responses: [{ nullifier: String(n) }] } });
    return v.body.human;
  };
  return { call, login, walletMessage, close: () => server.close() };
}

test("problem statement signals: one per human, re-picking moves it, no stake involved", async () => {
  const t = await boot();
  assert.equal((await t.call("/api/predictions/signal", { option: 1 })).status, 401);
  await t.login(1);
  await t.call("/api/predictions/signal", { option: 1 });
  let r = await t.call("/api/predictions/signal", { option: 2 });
  assert.deepEqual(r.body.counts.slice(0, 3), [0, 0, 1]);
  await t.login(2);
  r = await t.call("/api/predictions/signal", { option: 2 });
  assert.equal(r.body.counts[2], 2);
  assert.equal((await t.call("/api/predictions/signal", { option: 99 })).status, 400);
  t.close();
});

test("registration needs a deployed contract and owner key", async () => {
  const t = await boot({ PREDICTIONS_OWNER_KEY: "" });
  const h = await t.login(3);
  const message = t.walletMessage(h.playerId, player.address);
  await t.call("/api/human/wallet", { address: player.address, message, signature: await player.signMessage({ message }) });
  const r = await t.call("/api/predictions/register", {});
  assert.equal(r.status, 503);
  t.close();
});

test("verified wallet is registered on-chain exactly once (local anvil)", { skip: !RPC && "set PREDICTIONS_TEST_RPC to a local anvil --chain-id 1874" }, async () => {
  const chain = defineChain({ id: 1874, name: "anvil", nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const owner = privateKeyToAccount(ANVIL_KEY);
  const art = JSON.parse(readFileSync("contracts/out/OmenPredictions.sol/OmenPredictions.json", "utf8"));
  const w = createWalletClient({ account: owner, chain, transport: http(RPC) });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const hash = await w.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [zeroAddress, owner.address] });
  const addr = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  const t = await boot({ PREDICTIONS_OWNER_KEY: ANVIL_KEY, PREDICTIONS_RPC: RPC, PREDICTIONS_CONTRACT: addr });
  const h = await t.login(4);
  const message = t.walletMessage(h.playerId, player.address);
  await t.call("/api/human/wallet", { address: player.address, message, signature: await player.signMessage({ message }) });
  const r = await t.call("/api/predictions/register", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.txHash);
  assert.equal(await pub.readContract({ address: addr, abi: art.abi, functionName: "verified", args: [player.address] }), true);
  assert.equal(await pub.readContract({ address: addr, abi: art.abi, functionName: "points", args: [player.address] }), 1_000_000_000n);
  const again = await t.call("/api/predictions/register", {});
  assert.equal(again.body.already, true);
  assert.equal((await t.call("/api/predictions/status")).body.verifiedOnChain, true);
  t.close();
});
