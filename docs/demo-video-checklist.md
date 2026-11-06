# Demo video checklist

One cut can serve all three sponsors: **2:30–2:59** fits Whitechain (2–4 min) and 0G (< 3 min).
Record only *after* the live evidence exists. Never show a fork or DEMO payment as a testnet one.

**Before recording**

- [ ] `.env` set: `CHECKOUT_ADDRESS` (verified testnet contract), `VITE_ARKIV_ACCESS_KEY`, 0G key
- [ ] Wallet on Whitechain Sepolia with test USDT + a little WBT; tGLM on Rabdi
- [ ] Fresh browser profile (so the tutorial shows), sound on, 1280×800 or larger
- [ ] Explorer tabs pre-opened: the checkout contract (shows **verified**), Maya's payout address

**Shots (target times)**

1. 0:00–0:15 Title → Blockhaven. One line: "a courier game where you pay village stalls by scanning UPI QR codes with stablecoins."
2. 0:15–0:35 Walk to Maya's stall, press **E** on the QR sign, the tutorial's three cards.
3. 0:35–1:05 **Payer**: pick an item, pay with USDT, read out the quote (merchant ₹, fee, live rate, USDT), the safety check **with the 0G request ID on screen**.
4. 1:05–1:35 Approve in the wallet (both prompts), coin flies to the relay and to Maya, receipt with **REAL TESTNET** and **SIMULATED INR** visible. Say the rupee leg is simulated.
5. 1:35–1:55 **Merchant**: the explorer shows the tx and Maya's payout address receiving USDT; the contract page shows the verified source.
6. 1:55–2:15 Save receipt to Arkiv (wallet prompt) → Wallet → History → **Load from Arkiv** shows the record with **ON ARKIV**.
7. 2:15–2:35 Scan a spoofed QR ("KYC Refund Desk"): blocked, with reasons.
8. 2:35–2:55 Close: what's real (testnet USDT, Arkiv, 0G) vs simulated (INR payout), repo link.

**After recording**

- [ ] Paste the tx hash, contract address, Arkiv entity key + writer wallet, and 0G request ID into README "Sponsor evidence"
- [ ] Upload; add the link to the README and the ETHGlobal submission
