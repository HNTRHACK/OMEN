// Routes added by later Final Block steps: the ChaiPay tutorial payment proxy (step 2) and the
// prediction booths (step 4).
//
// ChaiPay (Whitechain Sepolia, verified source on the explorer): the payer signs an EIP-712 `Pay`
// intent; the ChaiPay relayer submits it and pays the gas; USDT moves from the payer's ChaiPay
// balance into an escrowed order. We never report success from the relayer's word alone: the
// order must be on-chain (an OrderOpened log for this payer in the returned transaction).
import { createPublicClient, http, parseAbi, parseEventLogs, verifyTypedData, getAddress, isAddress } from "viem";

import { CHAIPAY as C, PAY_TYPES, PAY_DOMAIN, TUTORIAL_PAYEE_HASH, TUTORIAL_MAX } from "../shared/chaipay.js";
export const CHAIPAY = { ...C, rpc: process.env.WHITECHAIN_RPC || "https://rpc.testnet.whitechain.io/" };

const ORDER_OPENED = parseAbi(["event OrderOpened(uint256 indexed orderId, address indexed payer, bytes32 indexed payeeHash, uint64 inrPaise, uint128 usdtAmount)"]);

export function mountFinalRoutes(final, { fetchImpl = fetch, chain = null, relayerUrl = final.config.chaipayUrl } = {}) {
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

  return final;
}

export const isAddr = isAddress;
