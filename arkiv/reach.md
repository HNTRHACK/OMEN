# Reach

**Who this is for.** People who pay at Indian street stalls and kirana shops by scanning UPI QR
codes, which is most of urban India, and who also hold stablecoins. OMEN wraps the flow in a
small game, so it's also a gentle way to show non-crypto players what "scan, approve, settle"
means, with DEMO credits and no wallet needed to start.

**What Arkiv gets from it.** A consumer-facing pattern that's easy to copy: *the payer's wallet
writes a readonly receipt, the app reads it back by owner*. Any checkout (crypto or not) can use
the same `omen.record.v1`-style schema for wallet-owned receipts.

**How people find it.** Public repo and live demo link (see README), the ETHGlobal Mumbai
showcase, and the game itself: the Arkiv step is visible in the receipt screen
("Save receipt to Arkiv") and the history ("ON ARKIV").

**Honest limits today.** Arkiv writes need a wallet funded with Rabdi test GLM, so DEMO-only
players see the button but can't use it until they connect and fund a wallet.
