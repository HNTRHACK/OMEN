// Crypto → INR off-ramp. A UPI QR alone can't put rupees into a bank account: that needs a
// licensed payout partner. This is the seam where one plugs in.
//
// A provider implements:
//   name: string
//   real: boolean                       true ONLY for an authorized, integrated payout partner
//   payout(payment): Promise<{ status: "settled" | "pending" | "failed", providerRef?: string }>
//
// Rules (enforced in payments.js and the UI):
//   - INR is shown as "settled" only when a real provider returns status "settled" with its own
//     reference. OMEN never generates a bank receipt, UTR or payout reference itself.
//   - With no real provider (today), the INR leg is a DEMO INR SETTLEMENT: the quoted equivalent
//     of a confirmed testnet crypto payment, and nothing more.

/** The only provider shipped: no money moves and no reference is invented. */
export const noProvider = {
  name: "none",
  real: false,
  async payout() {
    return { status: "not_attempted" };
  },
};

export function inrLeg(provider, result) {
  if (provider.real && result.status === "settled" && result.providerRef)
    return { real: true, status: "settled", label: `INR settled by ${provider.name}`, providerRef: result.providerRef };
  if (provider.real) return { real: true, status: result.status, label: `INR payout ${result.status} (${provider.name})`, providerRef: result.providerRef || null };
  return { real: false, status: "demo", label: "DEMO INR SETTLEMENT: quoted equivalent only, no rupees moved", providerRef: null };
}
