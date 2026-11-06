// Payment service: scan → quote → risk → authorize → submit → verify → (simulated) INR payout.
// All side effects (clock, rates, 0G, chain) are injected so the whole flow is testable offline.

import { randomBytes, randomUUID } from "node:crypto";
import { getAddress, isAddress, recoverTypedDataAddress } from "viem";
import { authorizationTypedData, forViem } from "../shared/eip3009.js";
import { noProvider, inrLeg } from "./offramp.js";
import { parseUpiQr, UpiError, inrToPaise, MAX_INR_PAISE, formatInr } from "../shared/upi.js";
import { merchantByVpa, merchantKey } from "../shared/merchants.js";
import { quote, formatUnits, FEE_BPS } from "../shared/money.js";
import { USDT, txUrl } from "../shared/chains.js";
import { S, transition, expireIfStale, TERMINAL } from "./stateMachine.js";
import { assess } from "./risk.js";
import { VerifyError } from "./chain.js";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// DEMO credits: 1 credit = ₹1 by definition, 2 decimals. No chain, no value.
export const DEMO = { symbol: "DEMO", decimals: 2, rate: "1" };

export function createPaymentService({ store, rates, infer, verify, checkoutConfigured, checkoutAddress = () => null, relayer = null, offramp = noProvider, onChange = () => {}, quoteTtlMs = 120_000, now = () => Date.now() }) {
  // Every state change goes through save(), which also tells listeners (merchant views, webhooks).
  const save = (p) => {
    store.put(p);
    try {
      onChange(p);
    } catch (e) {
      console.error("onChange listener failed:", e);
    }
    return p;
  };
  const need = (id) => {
    const p = store.get(String(id));
    if (!p) throw new ApiError(404, "not_found", "No such payment.");
    if (expireIfStale(p, now())) save(p);
    return p;
  };

  async function create({ qr, amountInr, token }) {
    let upi;
    try {
      upi = parseUpiQr(qr);
    } catch (e) {
      if (e instanceof UpiError) throw new ApiError(400, e.code, e.message);
      throw e;
    }
    let inrPaise = upi.amountPaise;
    if (inrPaise == null) {
      try {
        inrPaise = inrToPaise(amountInr);
      } catch {
        throw new ApiError(400, "amount_required", "This QR has no amount. Enter how many rupees to pay.");
      }
      if (inrPaise <= 0 || inrPaise > MAX_INR_PAISE) throw new ApiError(400, "bad_amount", `Enter an amount between ₹0.01 and ${formatInr(MAX_INR_PAISE)}.`);
    }

    const merchant = merchantByVpa(upi.vpa);
    const mode = token === "USDT" ? "testnet" : token === "DEMO" ? "demo" : null;
    if (!mode) throw new ApiError(400, "bad_token", "Choose USDT (Whitechain testnet) or DEMO credits.");
    if (mode === "testnet" && !merchant) throw new ApiError(400, "unregistered_testnet", "Real testnet USDT can only pay registered Blockhaven merchants. Use DEMO credits for other QR codes.");
    if (mode === "testnet" && !checkoutConfigured()) throw new ApiError(503, "checkout_off", "The Whitechain checkout contract isn't configured on this server yet. Use DEMO credits.");

    const r = mode === "testnet" ? await rates() : { rate: DEMO.rate, source: "fixed-demo", at: now() };
    const q = quote(inrPaise, r.rate, mode === "testnet" ? USDT.decimals : DEMO.decimals);
    const t = now();
    const p = {
      id: randomUUID(),
      mode,
      state: S.QUOTED,
      createdAt: t,
      updatedAt: t,
      upi: { vpa: upi.vpa, name: upi.name, note: upi.note, mcc: upi.mcc, amountFromQr: upi.amountPaise != null },
      merchant: merchant ? { id: merchant.id, name: merchant.name, npc: merchant.npc } : null,
      quote: {
        token: mode === "testnet" ? "USDT" : "DEMO",
        inrPaise: q.inrPaise,
        feePaise: q.feePaise,
        feeBps: q.feeBps,
        totalPaise: q.totalPaise,
        rate: q.rate,
        rateSource: r.source,
        rateNote: r.note,
        rateAt: r.at ?? now(),
        tokenUnits: q.tokenUnits.toString(),
        tokenAmount: formatUnits(q.tokenUnits, q.decimals),
        decimals: q.decimals,
        expiresAt: t + quoteTtlMs,
      },
      risk: null,
      payer: null,
      chain: null,
      txHash: null,
      payout: null,
      history: [{ to: S.QUOTED, at: t }],
    };
    return save(p);
  }

  async function risk(id) {
    const p = need(id);
    if (p.state !== S.QUOTED) return p; // idempotent: already assessed (or terminal)
    const upi = { ...p.upi, amountPaise: p.upi.amountFromQr ? p.quote.inrPaise : null };
    p.risk = await assess(upi, p.quote.inrPaise, infer);
    if (p.risk.decision === "block") transition(p, S.BLOCKED, { reason: "Risk check blocked this payment." }, now());
    else transition(p, S.RISK_ASSESSED, { decision: p.risk.decision, ai: p.risk.ai.status }, now());
    return save(p);
  }

  function authorize(id, { payer, acknowledgeRisk } = {}) {
    const p = need(id);
    if (p.state !== S.RISK_ASSESSED) throw new ApiError(409, "bad_state", `Payment is ${p.state}; it can't be authorized now.`);
    if (p.risk.decision === "review" && acknowledgeRisk !== true) throw new ApiError(400, "needs_ack", "This payment needs your review. Confirm you've read the warnings.");
    if (p.mode === "testnet") {
      if (!isAddress(payer || "")) throw new ApiError(400, "bad_payer", "Connect a wallet first.");
      p.payer = getAddress(payer);
      p.chain = {
        orderId: "0x" + randomBytes(32).toString("hex"),
        merchantKey: merchantKey(p.merchant.id),
        payer: p.payer,
        amount: p.quote.tokenUnits,
        inrPaise: String(p.quote.inrPaise),
        deadline: String(Math.floor(p.quote.expiresAt / 1000)),
      };
      // Gasless (Operate): the payer signs this EIP-3009 authorization; the relayer pays the gas.
      p.chain.gasless = !!(relayer && checkoutAddress());
      if (p.chain.gasless) p.chain.typedData = authorizationTypedData(checkoutAddress(), p.chain);
    } else if (payer && isAddress(payer)) p.payer = getAddress(payer);
    transition(p, S.AWAITING_WALLET, {}, now());
    return save(p);
  }

  async function submit(id, { txHash, demoRef } = {}) {
    const p = need(id);
    if (p.state !== S.AWAITING_WALLET) {
      if (p.state === S.SUBMITTED) return refresh(id);
      throw new ApiError(409, "bad_state", `Payment is ${p.state}; it can't be submitted.`);
    }
    if (p.mode === "demo") {
      transition(p, S.SUBMITTED, { demoRef: String(demoRef || "").slice(0, 40) }, now());
      transition(p, S.CONFIRMED, { settlement: "DEMO credits (no blockchain)" }, now());
      return settleInr(p);
    }
    const hash = String(txHash || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, "bad_hash", "Send the transaction hash from your wallet.");
    if (!store.claimTx(hash)) throw new ApiError(409, "tx_reused", "That transaction has already been used for a payment.");
    p.txHash = hash;
    transition(p, S.SUBMITTED, { txHash: hash }, now());
    save(p);
    return refresh(id);
  }

  async function refresh(id) {
    const p = need(id);
    if (p.state !== S.SUBMITTED || p.mode !== "testnet") return p;
    try {
      const v = await verify(p, p.txHash);
      // Another request may have settled it while we awaited the chain: don't settle twice.
      if (p.state !== S.SUBMITTED) return p;
      p.onchain = { ...v, explorer: txUrl(p.txHash) };
      transition(p, S.CONFIRMED, { blockNumber: v.blockNumber }, now());
      return settleInr(p);
    } catch (e) {
      if (p.state !== S.SUBMITTED) return p; // settled by a concurrent request
      if (e instanceof VerifyError && e.retry) {
        p.verifyNote = e.message;
        return save(p);
      }
      store.releaseTx(p.txHash);
      transition(p, S.FAILED, { reason: e.message, code: e.code }, now());
      return save(p);
    }
  }

  /** Gasless: relay the payer's signed authorization. The payer sends no transaction and pays no gas. */
  async function relay(id, { signature } = {}) {
    const p = need(id);
    if (p.mode !== "testnet") throw new ApiError(400, "not_testnet", "Only testnet USDT payments are relayed.");
    // Idempotent: a client retrying after a lost response gets the payment's real state back.
    if (p.state === S.SUBMITTED) return refresh(id);
    if (p.relayed && [S.CONFIRMED, S.PAYOUT_SIMULATED, S.COMPLETED].includes(p.state)) return p;
    if (p.state !== S.AWAITING_WALLET) throw new ApiError(409, "bad_state", `Payment is ${p.state}; it can't be relayed.`);
    if (!relayer || !p.chain?.gasless) throw new ApiError(503, "relayer_off", "Gasless checkout isn't configured on this server.");
    if (p.relaying) throw new ApiError(409, "in_progress", "This payment is already being submitted.");
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(signature || ""))) throw new ApiError(400, "bad_signature", "Send the 65-byte signature from your wallet.");
    if (now() >= Number(p.chain.deadline) * 1000) throw new ApiError(400, "expired", "The quote expired before it was signed. Get a new quote.");
    p.relaying = true; // lock before the first await: two requests can't both spend relayer gas
    try {
      const signer = await recoverTypedDataAddress({ ...forViem(p.chain.typedData), signature });
      if (getAddress(signer) !== p.payer) throw new ApiError(400, "bad_signature", "That signature isn't from the paying wallet.");
      const hash = await relayer.relay({ ...p.chain, payer: p.payer }, signature);
      if (!store.claimTx(hash)) throw new ApiError(409, "tx_reused", "That transaction is already linked to a payment.");
      p.txHash = hash.toLowerCase();
      p.relayed = true;
      transition(p, S.SUBMITTED, { txHash: p.txHash, relayed: true }, now());
    } finally {
      delete p.relaying;
    }
    save(p);
    return refresh(id);
  }

  async function settleInr(p) {
    // The INR leg goes through the off-ramp provider. Without an authorized one (today), it is a
    // DEMO INR SETTLEMENT: no rupees move and no payout reference is invented.
    let result;
    try {
      result = await offramp.payout(p);
    } catch (e) {
      result = { status: "failed", error: String(e.message || e).slice(0, 120) };
    }
    const leg = inrLeg(offramp, result);
    p.payout = { ...leg, simulated: !leg.real, inrPaise: p.quote.inrPaise, to: p.upi.vpa };
    if (leg.real && leg.status !== "settled") return save(p); // crypto confirmed; INR not (yet) settled
    transition(p, S.PAYOUT_SIMULATED, { inr: leg.label }, now());
    transition(p, S.COMPLETED, {}, now());
    return save(p);
  }

  function cancel(id) {
    const p = need(id);
    if (TERMINAL.has(p.state)) return p;
    transition(p, S.CANCELLED, { reason: "Cancelled by payer." }, now());
    return save(p);
  }

  return { create, risk, authorize, submit, relay, refresh, cancel, get: need, feeBps: FEE_BPS };
}
