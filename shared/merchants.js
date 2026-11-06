import { keccak256, toBytes } from "viem";
import { buildUpiQr } from "./upi.js";

// Blockhaven's merchants. Their UPI handles use the fictional "@blockhaven" bank so they can
// never collide with a real person's UPI ID.
export const MERCHANTS = [
  {
    id: "maya-chai",
    npc: "maya",
    name: "Maya's Chai Stall",
    vpa: "maya.chai@blockhaven",
    mcc: "5814",
    items: [
      { id: "cutting", name: "Cutting chai", paise: 2000 },
      { id: "masala", name: "Masala chai + bun maska", paise: 6000 },
      { id: "festival", name: "Festival order: 40 cups", paise: 80000 },
    ],
  },
  {
    id: "orin-relay",
    npc: "orin",
    name: "Orin's Relay Works",
    vpa: "orin.relay@blockhaven",
    mcc: "7622",
    items: [
      { id: "fuse", name: "Spare relay fuse", paise: 15000 },
      { id: "tuneup", name: "Lantern tune-up", paise: 45000 },
    ],
  },
];

/** bytes32 merchant id used by OmenCheckout (keccak256 of the slug). */
export const merchantKey = (id) => keccak256(toBytes(id));
export const merchantById = (id) => MERCHANTS.find((m) => m.id === id) || null;
export const merchantByVpa = (vpa) => MERCHANTS.find((m) => m.vpa === String(vpa).toLowerCase()) || null;

export const merchantQr = (m, item) =>
  buildUpiQr({ vpa: m.vpa, name: m.name, mcc: m.mcc, amountPaise: item?.paise, note: item?.name });

/** OmenCheckout's DIRECT_TAG (top 96 bits): a direct merchant id pays the address in its low 160 bits. */
export const DIRECT_TAG_HEX = "0dec0dec0dec0dec0dec0dec";
/** Same as OmenCheckout.directMerchantId(payout): player shops need no on-chain registration. */
export function directMerchantId(payout) {
  const a = String(payout).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a) || /^0x0{40}$/.test(a)) throw new Error("bad payout address");
  return `0x${DIRECT_TAG_HEX}${a.slice(2)}`;
}
