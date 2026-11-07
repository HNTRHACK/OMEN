// EIP-3009 ReceiveWithAuthorization for Whitechain's test USDT (TetherTokenV2). The domain was
// checked against the token's on-chain DOMAIN_SEPARATOR (0xcdcfacb6…2a25) on 2026-11-06.
import { encodeAbiParameters, keccak256, getAddress } from "viem";
import { USDT, WHITECHAIN } from "./chains.js";

export const USDT_DOMAIN = { name: "Tether USD", version: "1", chainId: WHITECHAIN.id, verifyingContract: USDT.address };

export const RWA_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** Same as OmenCheckout.authorizationNonce: binds the signature to every order term. */
export function authorizationNonce(checkout, c) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [getAddress(checkout), c.orderId, c.merchantKey, BigInt(c.amount), BigInt(c.inrPaise), BigInt(c.deadline)],
    ),
  );
}

/** The typed data the payer signs (eth_signTypedData_v4). JSON-safe: numbers as strings. */
export function authorizationTypedData(checkout, c) {
  return {
    domain: USDT_DOMAIN,
    types: RWA_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: getAddress(c.payer),
      to: getAddress(checkout),
      value: String(c.amount),
      validAfter: "0",
      validBefore: String(c.deadline),
      nonce: authorizationNonce(checkout, c),
    },
  };
}

/** Typed data with BigInt fields, as viem's sign/verify functions want. */
export const forViem = (td) => ({
  ...td,
  message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) },
});
