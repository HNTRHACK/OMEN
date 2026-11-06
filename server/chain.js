// Verifies a Whitechain transaction really paid a given order through OmenCheckout. The server
// never trusts the browser's word that a payment happened: it reads the receipt from the chain.

import { createPublicClient, http, parseEventLogs, isHash, getAddress } from "viem";
import { WHITECHAIN } from "../shared/chains.js";
import { config } from "./config.js";

export const CHECKOUT_ABI = [
  {
    type: "event",
    name: "Paid",
    inputs: [
      { name: "orderId", type: "bytes32", indexed: true },
      { name: "merchantId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payout", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "inrPaise", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "merchantId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "inrPaise", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "merchants", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "payout", type: "address" }, { name: "active", type: "bool" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

let client;
export const chainClient = () =>
  (client ||= createPublicClient({ chain: { id: WHITECHAIN.id, name: WHITECHAIN.name, nativeCurrency: WHITECHAIN.native, rpcUrls: { default: { http: [config.whitechainRpc] } } }, transport: http(config.whitechainRpc, { timeout: 15_000 }) }));

export class VerifyError extends Error {
  constructor(code, message, { retry = false } = {}) {
    super(message);
    this.code = code;
    this.retry = retry; // true: not mined yet, ask again later
  }
}

/**
 * @param {object} p  payment with p.chain = { orderId, merchantKey, payer, amount (string units) }
 * @returns {{ blockNumber: string, confirmations: number, payout: string, amount: string }}
 */
export async function verifyPayment(p, txHash, c = chainClient()) {
  if (!isHash(txHash)) throw new VerifyError("bad_hash", "That isn't a transaction hash.");
  if (!config.checkoutAddress) throw new VerifyError("not_configured", "CHECKOUT_ADDRESS isn't set on the server.");
  let receipt;
  try {
    receipt = await c.getTransactionReceipt({ hash: txHash });
  } catch (e) {
    if (/not be found|not found/i.test(e.shortMessage || e.message)) throw new VerifyError("pending", "Not mined yet.", { retry: true });
    throw new VerifyError("rpc", `Whitechain RPC error: ${e.shortMessage || e.message}`, { retry: true });
  }
  if (receipt.status !== "success") throw new VerifyError("reverted", "The transaction reverted on-chain.");
  const checkout = getAddress(config.checkoutAddress);
  if (!receipt.to || getAddress(receipt.to) !== checkout) throw new VerifyError("wrong_contract", "The transaction didn't call the OMEN checkout contract.");

  const logs = parseEventLogs({ abi: CHECKOUT_ABI, eventName: "Paid", logs: receipt.logs.filter((l) => getAddress(l.address) === checkout) });
  const ev = logs.find((l) => l.args.orderId.toLowerCase() === p.chain.orderId.toLowerCase());
  if (!ev) throw new VerifyError("no_event", "No Paid event for this order in that transaction.");
  if (ev.args.merchantId.toLowerCase() !== p.chain.merchantKey.toLowerCase()) throw new VerifyError("wrong_merchant", "That payment went to a different merchant.");
  if (getAddress(ev.args.payer) !== getAddress(p.chain.payer)) throw new VerifyError("wrong_payer", "That payment came from a different wallet.");
  if (ev.args.amount < BigInt(p.chain.amount)) throw new VerifyError("underpaid", "The on-chain amount is less than the quote.");

  const head = await c.getBlockNumber();
  const confirmations = Number(head - receipt.blockNumber) + 1;
  if (confirmations < config.minConfirmations) throw new VerifyError("confirming", `Waiting for confirmations (${confirmations}/${config.minConfirmations}).`, { retry: true });
  return { blockNumber: receipt.blockNumber.toString(), confirmations, payout: ev.args.payout, amount: ev.args.amount.toString() };
}

/** Read a merchant's on-chain registration (null if the checkout isn't configured). */
export async function onchainMerchant(merchantKey, c = chainClient()) {
  if (!config.checkoutAddress) return null;
  const [payout, active] = await c.readContract({ address: config.checkoutAddress, abi: CHECKOUT_ABI, functionName: "merchants", args: [merchantKey] });
  return { payout, active };
}
