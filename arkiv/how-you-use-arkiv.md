# How OMEN uses Arkiv

OMEN is a story game where you can pay village merchants by scanning a UPI QR with crypto. Arkiv
is where the **player's own payment and delivery records live**, and where the in-game history
reads them back from.

1. **Write.** After a payment completes, the receipt has a *Save receipt to Arkiv* button. The
   player's wallet switches to Rabdi and signs one `createEntity` with the `omen.record.v1` schema:
   merchant, INR amount, token amount, the Whitechain settlement tx, the 0G risk-check request ID,
   and the simulated payout reference. Story deliveries (KAI handing Orin the receipt, handing
   Maya the sealed findings) are queued as `delivery` records and written from *Wallet → History*.
2. **Read.** *Wallet → History → Load from Arkiv* queries every `omen.record.v1` entity owned by
   the connected wallet, newest first, and renders it in the game's transaction history with an
   **ON ARKIV** badge and links to the Arkiv and Whitechain explorers. This is a user-facing read,
   not a log.
3. **Ownership and lifetime.** The wallet owns its records; they're created `readonly` so a
   receipt can't be rewritten, and they expire after 30 days.

Data flow: Whitechain holds the money movement; Arkiv holds the queryable, wallet-owned record
that ties that movement to the merchant, the INR quote, and the AI risk check. The two are linked
by the `whitechainTx` and `zgRequestId` columns.

Code: [`shared/arkivRecord.js`](../shared/arkivRecord.js) (schema + validated values),
[`src/pay/arkiv.js`](../src/pay/arkiv.js) (write + query),
[`test/arkiv.test.js`](../test/arkiv.test.js) (values validated with the SDK's own constructors).
