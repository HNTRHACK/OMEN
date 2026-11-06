// ChaiPay on Whitechain Sepolia: shared by the server proxy and the in-game tutorial payment.
// Source verified on the explorer (src/ChaiPay.sol). EIP-712 domain read on-chain via eip712Domain().
import { keccak256, toHex } from "viem";

export const CHAIPAY = {
  address: "0x3DB25D9ee7dB7FD250d80637677ADf5f5753d419",
  chainId: 1874,
  explorer: "https://explorer.testnet.whitechain.io",
};
export const PAY_DOMAIN = { name: "ChaiPay", version: "1", chainId: CHAIPAY.chainId, verifyingContract: CHAIPAY.address };
export const PAY_TYPES = {
  Pay: [
    { name: "payer", type: "address" },
    { name: "payeeHash", type: "bytes32" },
    { name: "inrPaise", type: "uint64" },
    { name: "usdtAmount", type: "uint128" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const CHAIPAY_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
];
/** The tutorial's only payee: Maya's chai stall (keccak256 of a UPI-style VPA, as ChaiPay expects). */
export const TUTORIAL_PAYEE = "maya.chai@blockhaven";
export const TUTORIAL_PAYEE_HASH = keccak256(toHex(TUTORIAL_PAYEE));
/** One cup: ₹20, priced at 0.25 test USDT (a fixed demo rate, labelled as such). */
export const TUTORIAL_PRICE = { inrPaise: 2000n, usdtAmount: 250_000n };
export const TUTORIAL_MAX = { inrPaise: 10_000n, usdtAmount: 1_000_000n };
