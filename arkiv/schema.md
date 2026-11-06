# Arkiv schema

OMEN writes one kind of entity, through the SDK schema `omen.record.v1`
([`shared/arkivRecord.js`](../shared/arkivRecord.js)). Being a named schema, every entity also
carries the indexed attribute `arkiv.schema = "omen.record.v1"`, which keeps OMEN's records apart
from anything else on the chain.

Network: Arkiv **Rabdi** testnet, chain ID 7794095, written with `@arkiv-network/sdk` 1.0.1.

## Entity: `omen.record.v1`

One entity per **payment** (a scan-and-pay checkout at a village merchant) or per **courier
delivery** (a story delivery KAI completes).

| Column | Type | Indexed | Meaning |
|---|---|---|---|
| `kind` | str | yes | `payment` or `delivery` |
| `mode` | str | yes | `testnet` (Whitechain USDT), `demo` (DEMO credits) or `story` (delivery) |
| `merchant` | str | yes | merchant slug (`maya-chai`, `orin-relay`), the UPI ID for other payees, or the delivery recipient |
| `status` | str | yes | final gateway state (`COMPLETED`, …) or `delivered` |
| `ref` | str | yes | OMEN payment id (UUID) or delivery id (`receipt-4127`, `findings-88`) |
| `createdAt` | u64 | yes | unix ms; used to sort newest first |
| `inrPaise` | u64 | no | what the merchant was quoted, in paise |
| `token` | str | no | `USDT` or `DEMO` |
| `amount` | str | no | token amount, human-readable (`0.640293`) |
| `whitechainTx` | str | no | Whitechain Sepolia tx hash of the settlement (empty for DEMO) |
| `zgRequestId` | str | no | 0G inference request ID of the risk check (empty if 0G was unavailable) |
| `payout` | str | no | `SIMULATED SIM-…`: the INR payout is simulated, and says so |
| `note` | str | no | free text (≤ 128 bytes) |

All `str` values are truncated to Arkiv's 128-byte limit on a UTF-8 boundary before the wallet is
asked to sign (`fitBytes`), and every value is built with the SDK's typed constructors, so a bad
record fails before a transaction exists.

## Who owns them

The **player's own wallet**. The browser builds a viem wallet client over the player's EIP-1193
provider (`custom(window.ethereum)`) on the Rabdi chain and calls `createEntity`; the player
approves it in their wallet. OMEN's server never writes to Arkiv and holds no Arkiv key.

Entities are created with `flags: { readonly: true }`: a receipt can't be edited after the fact,
even by its owner.

## When they expire

`ExpirationTime.fromDays(30)`: thirty days after creation.

## The queries

The in-game **Wallet → History → Load from Arkiv** button runs
([`src/pay/arkiv.js`](../src/pay/arkiv.js)):

```js
publicClient.select().from(Record)          // arkiv.schema = "omen.record.v1"
  .ownedBy(playerAddress)
  .orderBy(desc("createdAt"))
  .limit(50)
  .fetch()
```

and shows each record (with links to the Arkiv explorer entity and the Whitechain tx) in the
game's transaction history. `queryRecords(owner, "payment" | "delivery")` adds `eq("kind", …)`.

### One query judges can run

Replace `<WALLET>` with an address from the README's "Arkiv writer wallets" list:

```js
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { desc, eq } from "@arkiv-network/sdk/query";
import { http } from "viem";
import { Record } from "./shared/arkivRecord.js";

const pub = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() });
const { entities } = await pub.select().from(Record)
  .where(eq("kind", "payment")).ownedBy("<WALLET>")
  .orderBy(desc("createdAt")).limit(10).fetch();
console.log(entities);
```
