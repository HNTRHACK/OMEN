// Routes added by later Final Block steps: the ChaiPay tutorial payment proxy (step 2) and the
// prediction booths (step 4).
//
// ChaiPay (Whitechain Sepolia, verified source on the explorer): the payer signs an EIP-712 `Pay`
// intent; the ChaiPay relayer submits it and pays the gas; USDT moves from the payer's ChaiPay
// balance into an escrowed order. We never report success from the relayer's word alone: the
// order must be on-chain (an OrderOpened log for this payer in the returned transaction).
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, verifyTypedData, getAddress, isAddress, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { createRoyale } from "./royale.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CHAIPAY as C, PAY_TYPES, PAY_DOMAIN, TUTORIAL_PAYEE_HASH, TUTORIAL_MAX } from "../shared/chaipay.js";
export const CHAIPAY = { ...C, rpc: process.env.WHITECHAIN_RPC || "https://rpc.testnet.whitechain.io/" };

const ORDER_OPENED = parseAbi(["event OrderOpened(uint256 indexed orderId, address indexed payer, bytes32 indexed payeeHash, uint64 inrPaise, uint128 usdtAmount)"]);

export function mountFinalRoutes(final, { fetchImpl = fetch, chain = null, relayerUrl = final.config.chaipayUrl, database = null } = {}) {
  // Bounty Royale (free OMEN points, server-authoritative) needs PostgreSQL.
  if (database) {
    final.royale = createRoyale({ pool: database.pool, database, sessionOf: final.sessionOf, resolveSession: final.resolveSession });
    final.royale.mount(final);
    final.royale.ready = final.royale.seed();
  }
  const { HttpError } = final;
  const pub = chain || createPublicClient({ transport: http(CHAIPAY.rpc) });

  final.use("POST", /^\/api\/chaipay\/pay$/, async (body, req) => {
    const s = final.sessionOf(req);
    if (!s) throw new HttpError(401, "not_verified", "Verify with World ID first.");
    if (!s.human.wallet) throw new HttpError(400, "no_wallet", "Link a wallet first.");
    const i = body?.intent || {};
    let intent;
    try {
      intent = {
        payer: getAddress(i.payer),
        payeeHash: i.payeeHash,
        inrPaise: BigInt(i.inrPaise),
        usdtAmount: BigInt(i.usdtAmount),
        nonce: BigInt(i.nonce),
        deadline: BigInt(i.deadline),
      };
    } catch {
      throw new HttpError(400, "bad_intent", "Malformed payment intent.");
    }
    if (intent.payer !== s.human.wallet) throw new HttpError(403, "not_your_wallet", "That intent isn't from your linked wallet.");
    if (intent.payeeHash !== TUTORIAL_PAYEE_HASH) throw new HttpError(400, "bad_payee", "The tutorial only pays Maya's stall.");
    if (intent.inrPaise <= 0n || intent.inrPaise > TUTORIAL_MAX.inrPaise || intent.usdtAmount <= 0n || intent.usdtAmount > TUTORIAL_MAX.usdtAmount) throw new HttpError(400, "bad_amount", "Tutorial payments are tiny.");
    const ok = await verifyTypedData({ address: intent.payer, domain: PAY_DOMAIN, types: PAY_TYPES, primaryType: "Pay", message: intent, signature: body.signature }).catch(() => false);
    if (!ok) throw new HttpError(400, "bad_signature", "The signature doesn't match the intent.");

    // Hand the signed intent to the ChaiPay relayer (it pays the gas).
    const wire = { intent: Object.fromEntries(Object.entries(intent).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])), signature: body.signature };
    let r, j;
    try {
      r = await fetchImpl(`${relayerUrl}/api/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wire), signal: AbortSignal.timeout(20000) });
      j = await r.json().catch(() => null);
    } catch {
      throw new HttpError(502, "relayer_unreachable", "The ChaiPay relayer isn't reachable.");
    }
    const txHash = j?.txHash || j?.hash || j?.transactionHash;
    if (!r.ok || !/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) throw new HttpError(502, "relayer_refused", j?.message || j?.error || `The relayer answered ${r.status} without a transaction.`);

    // Trust the chain, not the relayer.
    let receipt;
    try {
      receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    } catch {
      throw new HttpError(504, "not_mined", "The relayer sent a transaction, but it hasn't been mined yet.");
    }
    const log = parseEventLogs({ abi: ORDER_OPENED, logs: receipt.logs }).find((l) => l.address.toLowerCase() === CHAIPAY.address.toLowerCase() && l.args.payer === intent.payer && l.args.usdtAmount === intent.usdtAmount);
    if (receipt.status !== "success" || !log) throw new HttpError(502, "no_order", "That transaction didn't open a ChaiPay order for you.");
    return { txHash, orderId: log.args.orderId.toString(), block: receipt.blockNumber.toString(), explorer: `${CHAIPAY.explorer}/tx/${txHash}`, usdtAmount: intent.usdtAmount.toString(), inrPaise: intent.inrPaise.toString() };
  });

  mountPredictions(final, { chain: pub });
  return final;
}

// ------------------------------------------------------------------ prediction booths (step 4)
const PRED_ABI = parseAbi(["function verified(address) view returns (bool)", "function setVerified(address[] players, bool isVerified)"]);
const MARKETS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "predictions", "markets.json");
export const loadMarkets = (file = process.env.PREDICTIONS_FILE || MARKETS_FILE) => JSON.parse(readFileSync(file, "utf8"));

function mountPredictions(final, { chain, markets = loadMarkets, ownerKey = process.env.PREDICTIONS_OWNER_KEY, rpc = process.env.PREDICTIONS_RPC || CHAIPAY.rpc, writer = null } = {}) {
  const { HttpError, db, save } = final;
  db.signals ||= {};
  const contract = () => process.env.PREDICTIONS_CONTRACT || markets().contract;
  const owner = /^0x[0-9a-fA-F]{64}$/.test(ownerKey || "") ? privateKeyToAccount(ownerKey) : null;
  const wallet = writer || (owner && createWalletClient({ account: owner, chain: defineChain({ id: 1874, name: "Whitechain Sepolia", nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }), transport: http(rpc) }));
  const read = writer ? chain : createPublicClient({ transport: http(rpc) });

  final.use("GET", /^\/api\/predictions\/status$/, async (_, req) => {
    const s = final.sessionOf(req);
    const c = contract();
    let onchain = false;
    if (c && s?.human.wallet) onchain = await read.readContract({ address: c, abi: PRED_ABI, functionName: "verified", args: [s.human.wallet] }).catch(() => false);
    return { contract: c || null, registration: !!wallet, human: final.publicHuman(s?.human) || null, verifiedOnChain: onchain, signal: s ? db.signals[s.human.playerId] ?? null : null };
  });

  /** The server tells the contract this wallet belongs to one World ID-verified human. */
  final.use("POST", /^\/api\/predictions\/register$/, async (_, req) => {
    const s = final.sessionOf(req);
    if (!s) throw new HttpError(401, "not_verified", "Verify with World ID first.");
    if (!s.human.wallet) throw new HttpError(400, "no_wallet", "Link a wallet first.");
    const c = contract();
    if (!c || !wallet) throw new HttpError(503, "predictions_not_deployed", "The prediction booths aren't open yet (contract not deployed or no owner key on the server).");
    if (await read.readContract({ address: c, abi: PRED_ABI, functionName: "verified", args: [s.human.wallet] })) return { verifiedOnChain: true, already: true };
    const hash = await wallet.writeContract({ address: c, abi: PRED_ABI, functionName: "setVerified", args: [[s.human.wallet], true] });
    const r = await read.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (r.status !== "success") throw new HttpError(502, "register_failed", "The registration transaction reverted.");
    return { verifiedOnChain: true, txHash: hash };
  });

  /** "Back a problem statement": one signal per verified human. Not a bet, no rewards. */
  final.use("POST", /^\/api\/predictions\/signal$/, async (body, req) => {
    const s = final.sessionOf(req);
    if (!s) throw new HttpError(401, "not_verified", "Verify with World ID first.");
    const wall = markets().booths.find((b) => b.signal);
    const i = Number(body?.option);
    if (!Number.isInteger(i) || i < 0 || i >= wall.options.length) throw new HttpError(400, "bad_option", "Pick one of the problem statements.");
    db.signals[s.human.playerId] = i;
    save();
    return tallies(wall);
  });
  final.use("GET", /^\/api\/predictions\/signals$/, async () => tallies(markets().booths.find((b) => b.signal)));
  const tallies = (wall) => {
    const counts = wall.options.map(() => 0);
    for (const v of Object.values(db.signals)) if (counts[v] !== undefined) counts[v]++;
    return { counts, total: counts.reduce((a, b) => a + b, 0) };
  };
}

export const isAddr = isAddress;
