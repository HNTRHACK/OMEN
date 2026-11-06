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
        throw new RelayError("would_revert", `The payment would fail on-chain (${e.shortMessage || e.message}). Nothing was sent.`, 400);
      }
      const hash = await wallet.writeContract({ address: config.checkoutAddress, abi: CHECKOUT_ABI, functionName: "payWithAuthorization", args, gas: GAS_CAP });
      sent.push(t);
      return hash;
    },
  };
}
