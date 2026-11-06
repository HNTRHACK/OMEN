// Gas relayer for gasless checkout. It submits the payer's signed EIP-3009 authorization to
// OmenCheckout.payWithAuthorization and pays the WBT gas, so the payer never sends a transaction.
//
// Drain protection (the relayer's WBT is the merchant's cost of doing business):
//   - only relays orders the gateway itself authorized, whose signature recovers to the payer
//     (checked in payments.js before this is called);
//   - simulates first: a payment that would revert costs nothing;
//   - hard gas cap per transaction; rolling hourly cap on relayed transactions;
//   - refuses when its own WBT balance is below a floor, so it degrades instead of failing mid-way.
import { createPublicClient, createWalletClient, http, parseSignature, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WHITECHAIN } from "../shared/chains.js";
import { config } from "./config.js";
import { CHECKOUT_ABI } from "./chain.js";

const GAS_CAP = 400_000n; // ~2.3x a measured gasless payment
export class RelayError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const INFRA = /failed to get|error sending request|timed? ?out|fetch failed|HTTP request failed|ECONN|ENOTFOUND|socket hang up|network|rate limit|429|502|503|504/i;

/**
 * Turn a failed simulation into an honest, short message. A node that can't be reached is NOT the
 * same as a payment that would fail: say which, never show a raw multi-line contract error, and
 * always say nothing was sent.
 */
export function classifyRelayError(e) {
  const text = `${e?.shortMessage || ""} ${e?.message || ""} ${e?.cause?.message || ""} ${e?.cause?.reason || ""}`;
  const reverted = e?.cause?.name === "ContractFunctionRevertedError" || /reverted with the following (reason|signature)/i.test(text);
  // viem reports some node failures (e.g. a fork's upstream timing out) as reverts, so judge the
  // reason text itself: a real contract revert carries a decoded reason/error name, an outage doesn't.
  const decoded = !!(e?.cause?.data?.errorName || (e?.cause?.reason && !INFRA.test(e.cause.reason)));
  if (INFRA.test(text) && !decoded) return new RelayError("chain_unreachable", "The Whitechain node isn't responding right now. Nothing was sent or charged. Please try again in a moment.", 503);
  const reason = String(e?.cause?.reason || e?.cause?.errorName || e?.shortMessage || "it would be refused").replace(/\s+/g, " ").slice(0, 120);
  return new RelayError("would_revert", reverted ? `The payment would be refused on-chain (${reason}). Nothing was sent or charged.` : `The payment can't be sent right now (${reason}). Nothing was sent or charged.`, 400);
}

export function relayerStatus() {
  return { configured: !!(config.relayerKey && config.checkoutAddress), maxPerHour: config.relayerMaxPerHour };
}

export function createRelayer({ now = () => Date.now() } = {}) {
  if (!config.relayerKey) return null;
  const chain = { id: WHITECHAIN.id, name: WHITECHAIN.name, nativeCurrency: WHITECHAIN.native, rpcUrls: { default: { http: [config.whitechainRpc] } } };
  const account = privateKeyToAccount(config.relayerKey);
  const pub = createPublicClient({ chain, transport: http(config.whitechainRpc, { timeout: 15_000 }) });
  const wallet = createWalletClient({ chain, account, transport: http(config.whitechainRpc, { timeout: 15_000 }) });
  const sent = []; // timestamps of relayed txs, for the hourly cap

  return {
    address: account.address,
    async balance() {
      return formatEther(await pub.getBalance({ address: account.address }));
    },
    /** Submit a signed authorization for an authorized order. Returns the tx hash. */
    async relay(c, signature) {
      const t = now();
      while (sent.length && t - sent[0] > 3_600_000) sent.shift();
      if (sent.length >= config.relayerMaxPerHour) throw new RelayError("relayer_busy", "The gas relayer has hit its hourly limit. Try again shortly.");
      const bal = await pub.getBalance({ address: account.address });
      if (bal < config.relayerMinWei) throw new RelayError("relayer_low", "The merchant's gas relayer is low on WBT, so gasless checkout is paused. Nothing was charged.");
      const { v, r, s, yParity } = parseSignature(signature);
      const args = [c.orderId, c.merchantKey, BigInt(c.amount), BigInt(c.inrPaise), BigInt(c.deadline), c.payer, Number(v ?? 27n + BigInt(yParity)), r, s];
      // Simulate first: if it would revert (expired, already paid, bad signature), spend nothing.
      try {
        await pub.simulateContract({ address: config.checkoutAddress, abi: CHECKOUT_ABI, functionName: "payWithAuthorization", args, account });
      } catch (e) {
        const err = classifyRelayError(e);
        console.warn(`[relayer] simulation failed (${err.code}):`, String(e?.shortMessage || e?.message || e).replace(/\s+/g, " ").slice(0, 300));
        throw err;
      }
      const hash = await wallet.writeContract({ address: config.checkoutAddress, abi: CHECKOUT_ABI, functionName: "payWithAuthorization", args, gas: GAS_CAP });
      sent.push(t);
      return hash;
    },
  };
}
