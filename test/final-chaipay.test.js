// ChaiPay tutorial proxy: only verified humans, only their linked wallet, only Maya's stall, only
// tiny amounts, only a valid EIP-712 signature — and success only when the chain shows the order.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { encodeEventTopics, encodeAbiParameters, parseAbi } from "viem";
import { createFinalBlock, walletMessage } from "../server/final-block.js";
import { mountFinalRoutes } from "../server/final-routes.js";
import { CHAIPAY, PAY_DOMAIN, PAY_TYPES, TUTORIAL_PAYEE_HASH, TUTORIAL_PRICE } from "../shared/chaipay.js";

const acct = privateKeyToAccount("0x" + "44".repeat(32));
const TX = "0x" + "ab".repeat(32);
const EV = parseAbi(["event OrderOpened(uint256 indexed orderId, address indexed payer, bytes32 indexed payeeHash, uint64 inrPaise, uint128 usdtAmount)"]);
const openedLog = (payer, amount) => ({
  address: CHAIPAY.address,
  topics: encodeEventTopics({ abi: EV, eventName: "OrderOpened", args: { orderId: 9n, payer, payeeHash: TUTORIAL_PAYEE_HASH } }),
  data: encodeAbiParameters([{ type: "uint64" }, { type: "uint128" }], [TUTORIAL_PRICE.inrPaise, amount]),
  blockNumber: 5n, transactionHash: TX, logIndex: 0, blockHash: "0x" + "00".repeat(32), transactionIndex: 0, removed: false,
});

async function boot({ relayer, receipt }) {
  const config = { appId: "app_t", rpId: "rp_t", signingKey: "11".repeat(32), environment: "staging", chaipayUrl: "http://relayer.test" };
  const fetchImpl = async (url, init) => {
    if (url.startsWith("https://developer.world.org")) return { ok: true, json: async () => ({ success: true }) };
    return relayer(url, JSON.parse(init.body));
  };
  const final = createFinalBlock({ config, store: { db: { humans: {}, sessions: {}, wallets: {} }, save() {} }, fetchImpl, signRequestImpl: () => ({}) });
  mountFinalRoutes(final, { fetchImpl, chain: { waitForTransactionReceipt: async () => receipt } });
  const server = createServer(async (req, res) => (await final(req, res)) || res.writeHead(404).end());
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, body: await r.json() };
  };
  const v = await call("/api/verify", { result: { action: "play-omen", environment: "staging", responses: [{ nullifier: "42" }] } });
  const message = walletMessage(v.body.human.playerId, acct.address);
  await call("/api/human/wallet", { address: acct.address, message, signature: await acct.signMessage({ message }) });
  return { call, close: () => server.close() };
}

const signed = async (over = {}) => {
  const intent = { payer: acct.address, payeeHash: TUTORIAL_PAYEE_HASH, ...TUTORIAL_PRICE, nonce: 0n, deadline: 9999999999n, ...over };
  const signature = await acct.signTypedData({ domain: PAY_DOMAIN, types: PAY_TYPES, primaryType: "Pay", message: intent });
  return { intent: Object.fromEntries(Object.entries(intent).map(([k, v]) => [k, String(v)])), signature };
};

test("a signed intent goes to the relayer, and success needs the OrderOpened log on-chain", async () => {
  let sent;
  const t = await boot({ relayer: async (url, body) => ((sent = { url, body }), { ok: true, json: async () => ({ txHash: TX }) }), receipt: { status: "success", blockNumber: 5n, logs: [openedLog(acct.address, TUTORIAL_PRICE.usdtAmount)] } });
  const r = await t.call("/api/chaipay/pay", await signed());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.url, "http://relayer.test/api/pay");
  assert.equal(sent.body.intent.usdtAmount, "250000");
  assert.equal(r.body.orderId, "9");
  assert.equal(r.body.explorer, `https://explorer.testnet.whitechain.io/tx/${TX}`);
  t.close();
});

test("relayer says ok but the chain has no order → not a success", async () => {
  const t = await boot({ relayer: async () => ({ ok: true, json: async () => ({ txHash: TX }) }), receipt: { status: "success", blockNumber: 5n, logs: [] } });
  const r = await t.call("/api/chaipay/pay", await signed());
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "no_order");
  t.close();
});

test("relayer down → relayer_unreachable (the game falls back to a labelled simulation)", async () => {
  const t = await boot({ relayer: async () => { throw new Error("ECONNREFUSED"); }, receipt: null });
  const r = await t.call("/api/chaipay/pay", await signed());
  assert.equal(r.body.error, "relayer_unreachable");
  t.close();
});

test("big amounts, other payees and forged signatures are refused before the relayer", async () => {
  let calls = 0;
  const t = await boot({ relayer: async () => (calls++, { ok: true, json: async () => ({}) }), receipt: null });
  assert.equal((await t.call("/api/chaipay/pay", await signed({ usdtAmount: 5_000_000n }))).body.error, "bad_amount");
  assert.equal((await t.call("/api/chaipay/pay", await signed({ payeeHash: "0x" + "11".repeat(32) }))).body.error, "bad_payee");
  const s = await signed();
  s.intent.inrPaise = "3000";
  assert.equal((await t.call("/api/chaipay/pay", s)).body.error, "bad_signature");
  assert.equal(calls, 0);
  t.close();
});
