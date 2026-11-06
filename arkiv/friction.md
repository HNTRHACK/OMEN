# Arkiv feedback (friction log)

Written while integrating `@arkiv-network/sdk` 1.0.1 on 2026-11-06.

## What worked well

- The schema API (`defineSchema`, typed columns, `.indexed()`) is pleasant, and the README's
  query examples (`select().from(schema).where(...).ownedBy(...).orderBy(desc(...))`) worked as
  written.
- Wallet writes go through viem's `sendTransaction`, so a **browser wallet** works with
  `createWalletClient({ transport: custom(window.ethereum), account: address })`. That's what makes
  records genuinely wallet-owned. Worth an explicit example in the README.
- `flags: { readonly: true }` is exactly right for receipts.
- The Rabdi RPC sends permissive CORS headers, so the browser can query directly.

## Where we got stuck or lost time

1. **Version drift between sources.** Search results and older docs mention Tiramisu, Kaolin and
   Mendoza; the GitHub README's sample `package.json` shows `^0.9.0`; npm has 1.0.1 with the `rabdi`
   chain. *Expected:* one canonical "current testnet + current SDK" page. *What we did:* read the
   installed package's `src/chains/rabdi.ts` to confirm chain ID 7794095.
2. **The 128-byte `str` limit isn't in the README.** We found `MAX_STRING_BYTES = 128` in
   `src/schema/values.ts`. Our first draft truncated notes to 140 *characters*, which would have
   failed at write time. *Repro:* `str("x".repeat(129))` throws `InvalidValueError`.
   *Suggestion:* document the limits (128 B per str, 128 KiB per bytes, 32 attributes) next to the
   type constructors.
3. **No public offline validator.** `encodeCreate` isn't exported, so to unit-test that our record
   would encode we build every value with the typed constructors (`str(v)`, `u64(v)`), which
   validate eagerly. An exported `validateValues(schema, values)` would help.
4. **Two chains in one checkout.** Payment settles on Whitechain, the record goes to Rabdi, so the
   wallet switches chains between steps. Not Arkiv's fault, but a short guide on multi-chain UX
   (or a relayer pattern that keeps wallet ownership) would help apps like ours.

## Feature wish

A way to grant a dapp a narrowly scoped, short-lived permission to create entities owned by the
user's wallet (session keys), so a game could write a receipt without a second wallet popup.
