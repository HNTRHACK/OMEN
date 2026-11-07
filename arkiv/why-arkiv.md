# Why Arkiv

A payment receipt is the clearest example of data that should belong to the person who paid,
not to the shop or the app:

- **The payer owns it.** Records are written by the player's wallet and owned by it. If OMEN's
  server disappears, the player's history is still on Arkiv and still queryable.
- **It's queryable, not just stored.** The in-game history needs "my payments, newest first",
  filtered by kind. Indexed attributes and `ownedBy(...).orderBy(...)` give that directly, with no
  indexer of our own. Putting the same data in Whitechain event logs would need a custom indexer to
  answer the same question.
- **It shouldn't change.** `readonly` entities mean a receipt can't be quietly edited after the
  fact. That's the whole plot of OMEN's first chapter: someone rewrote a tea seller's payment.
- **It shouldn't live forever.** A chai receipt doesn't need permanent storage. A 30-day
  expiration is honest about what this data is, and cheap.
- **The alternative was localStorage**, which is what OMEN used before: one browser, no proof, gone
  when the cache is cleared.
