# Demo video checklist

Target **2:30–2:55** (Whitechain asks for 2–4 minutes and to show each party: payer and merchant).
Record only *after* the live testnet evidence exists. Never present a fork or DEMO payment as a
testnet one.

**Before recording**

- [ ] Deployed on a public HTTPS URL (so a teammate on another device can join), with
      `CHECKOUT_ADDRESS` (verified on the explorer), `RELAYER_PRIVATE_KEY`, `MERCHANT_KEYS`,
      `VITE_ARKIV_ACCESS_KEY`, `TRUST_PROXY=1`
- [ ] Payer wallet on Whitechain Sepolia holding test USDT (no WBT needed: checkout is gasless),
      plus Rabdi test GLM for the Arkiv save
- [ ] Relayer funded with a little WBT
- [ ] Device 2: Maya's ledger open (`/merchant.html?m=maya-chai`), unlocked, sound on
- [ ] Device 3 (or a teammate): ready to open the invite link
- [ ] Fresh browser profile (so the tutorial shows), 1280×800 or larger
- [ ] Explorer tabs ready: the checkout contract (shows **verified**)

**Shots (target times)**

1. 0:00–0:15 Title card: "OMEN: a courier game where village stalls take stablecoins." Set a name
   and outfit, press *Play with friends*, copy the invite.
2. 0:15–0:40 The teammate joins: both couriers, name tags, different outfits; walk together, the
   feed shows what each does.
3. 0:40–1:05 Find the **Bitcoin** coin, press E: live INR/USD, 24 h change, chart, launch date,
   ATH/ATL. Say it's educational: nothing is credited.
4. 1:05–1:35 **Payer**: Maya's QR sign → pick an item → USDT. Read the quote: merchant ₹, fee,
   live rate and time, recipient, network, *₹0 gas for you*. The safety check.
5. 1:35–1:55 Sign once in the wallet (a signature, not a transaction). The coin flies through the
   relay to Maya. Receipt: **TESTNET CRYPTO PAYMENT**, USDT balance before → after. Say the rupee
   leg is a **DEMO INR SETTLEMENT**: no rupees move.
6. 1:55–2:15 **Merchant**: Maya's ledger chimes on device 2. Open the explorer: the tx was sent by
   the relayer; the contract is verified.
7. 2:15–2:40 Save the receipt to Arkiv (wallet prompt), refresh the page, open History: the record
   comes back **ON ARKIV**. The teammate inspects the same receipt link.
8. 2:40–2:55 Close: what's real (testnet USDT on Whitechain, Arkiv records) and what isn't (INR
   payout), and the repo link.

**After recording**

- [ ] Paste the contract address, payment tx, Arkiv entity key and writer wallet into README
      "Sponsor evidence"
- [ ] Upload; add the link to the README and the ETHGlobal submission
