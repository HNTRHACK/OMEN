# Backend B2: BTC to INR frontend API contract

Implemented on 2026-11-07. Backend: Codex; frontend: Claude. This confirms/amends
the [frontend proposal](../docs/contracts/btc-inr-frontend-requirements.md), which
remains unchanged. All frontend and 3D files remain unchanged by this backend work.

Every B2 payment is **SIMULATED BTC→INR SETTLEMENT**. DEMO BTC/INR have no cash
value. There is no Bitcoin transfer, bank deposit, UPI transfer, chain hash, UTR or
bank reference. This API never invokes Whitechain or Arkiv settlement. Every success
envelope and each customer, merchant, request, quote, receipt and balance event has
`settlement:"SIMULATED"` and `label:"SIMULATED BTC → INR SETTLEMENT"`.
Display that label on every payment screen. Errors use the standard error envelope.

## Authentication and decisions from the proposal

- Customer: existing `x-omen-token` (64 lowercase hex characters) proves possession
  of a guest identity, not a distinct human. Existing World ID sessions work via
  the HttpOnly player cookie or `x-omen-session`. A supplied player session takes
  precedence over guest credentials and fails closed if expired/revoked.
- **Merchant sign-up requires a player identity**, using the same options above.
  The merchant belongs to that player; only one merchant per player is permitted.
  Use a different player on Phone B from the customer on Phone A. Self-payment is
  rejected. No guest/World ID accounts or balances are automatically merged.
- Subsequent merchant operations need `Authorization: Bearer <64-hex session token>`
  or the separate merchant cookie. Customer and merchant credentials are independent.
- Sign-up/sign-in/recovery set an HttpOnly, SameSite=Strict cookie at `/`.
  Production adds Secure and uses `__Host-omen_btcinr_merchant`; development uses
  `omen_btcinr_merchant`. Same-origin clients can use this cookie instead of persisting
  tokens in localStorage. Explicit bearer credentials take precedence.
- Sessions last eight hours. Random access codes are shown once on sign-up/recovery.
  Only SHA-256 hashes of access codes and session tokens are stored. Keep the merchant
  ID and access code for another device. Never put any credential in a QR URL.
- Customer funding is **1,000,000 DEMO satoshis exactly once**. Re-registering updates
  the name without adding funds. Merchants start at zero DEMO INR.
- Per-payment limits: one paise through **1,000,000 paise (₹10,000)**. Quotes last at
  most 60 seconds, bounded further by rate freshness (120 seconds) and request expiry.
  Fixed requests expire after 15 minutes and are single-use; permanent receiving
  codes can accept many payments.
- Settlement is synchronous: new payments return **201**, `status:"confirmed"` and
  `version:1` after COMMIT. B2 creates no pending/failed receipts. Rejections roll back
  payment writes. A lost response needs the same quote/key retry, not a new key.
- Additional endpoint: explicit `POST /merchant/recover` for the owning player.
- `BTCINR_DEMO_INR_PER_BTC` selects an explicit `configured-demo` price. Unset it for
  CoinGecko; no silent fallback. Tests inject stale/unavailable providers through the
  service constructor. There is no public test-control endpoint or closed-app push.

## HTTP and JSON

Paths below start with `/api/btcinr`. POST needs `Content-Type: application/json`;
unexpected body fields are rejected. Responses use `Cache-Control: no-store`.
Money: paise are safe JSON integers; satoshis are decimal **strings**. Rates are INR
per BTC decimal strings with two fractional digits. Timestamps are epoch milliseconds.
The backend computes all debit/credit amounts; never use browser floating-point money.

| Method/path | Credential and input | Success |
| --- | --- | --- |
| GET `/customer` | Customer | 200 `{customer}`; 404 `no_account` if unenrolled |
| POST `/customer` | Customer; `{displayName}` (2–24 trimmed/moderated characters) | 200 `{customer}`; creates/funds once or updates name |
| GET `/rate` | Public | 200 rate below; 503 `rate_unavailable` if no cached rate |
| POST `/merchants` | **Player identity required**; `{businessName,displayName}` (2–48 and 2–24 characters) | **201** `{merchant,session,accessCode}`; cookie |
| POST `/merchant/session` | `{merchantId,accessCode}`; no player credential needed | 200 `{merchant,session}`; cookie |
| DELETE `/merchant/session` | Merchant; no body | 204; revokes session, clears cookie and disconnects its sockets |
| POST `/merchant/recover` | Owning player; `{}` | 200 `{merchant,session,accessCode}`; rotates code, revokes earlier sessions/sockets, retains balances/history |
| GET `/merchant` | Merchant | 200 `{merchant}` |
| POST `/merchant/requests` | Merchant; `{inrPaise,reference?}` (reference ≤40 characters) | 201 `{request}`; fixed amount and 15-minute expiry |
| GET `/requests/:code` | Customer/player identity | 200 `{request}`; merchant/amount resolved by server |
| POST `/quotes` | Customer; `{requestCode,inrPaise}` | 201 `{quote}`; immutable customer-bound quote |
| POST `/payments` | Customer; `{quoteId}` and UUID v4 `Idempotency-Key` header | 201 `{payment}` after COMMIT; matching retry 200 `{payment,replayed:true}` |
| GET `/payments/:id` | Paying customer or receiving merchant | 200 `{payment}`; other enrolled accounts see 404 `payment_not_found` |
| GET `/payments?role=customer\|merchant&limit=20&before=<cursor>` | Credential for selected role | 200 `{payments,nextCursor}`; newest first; limit 1–100, cursor opaque |

Success envelopes also include `settlement,label`. Object shapes:

- `customer`: `{id,displayName,balance:{btcSats},version,createdAt,settlement,label}`.
- `merchant`: `{id,businessName,displayName,balance:{inrPaise},version,receiveCode,createdAt,settlement,label}`.
- `session`: `{token,expiresAt}`. `accessCode` is returned only by sign-up/recovery.
- `request`: `{code,merchant:{id,businessName},inrPaise,reference,expiresAt,settlement,label}`.
  Permanent codes have `inrPaise:null,expiresAt:null`; fixed amounts cannot be overridden.
- `quote`: `{id,requestCode,merchant:{id,businessName},inrPaise,btcSats,inrPerBtc,rateSource,rateFetchedAt,createdAt,expiresAt,settlement,label}`.

IDs are opaque with `cus_`, `mer_`, `qt_`, `pay_`, `ord_` prefixes. Public IDs never
authorize requests. A public rate example:

```json
{
  "pair": "BTC/INR", "inrPerBtc": "5734210.55", "source": "coingecko",
  "fetchedAt": 1794000000000, "stale": false, "maxAgeMs": 120000,
  "settlement": "SIMULATED", "label": "SIMULATED BTC → INR SETTLEMENT"
}
```

CoinGecko `fetchedAt` is the provider's update time, not the cache-hit time. On provider
failure, a prior snapshot remains available, marked stale once too old; without a
snapshot return 503. Quotes save the exact rate/source/time. Payment honors that
snapshot until quote expiry, without fetching/repricing at confirmation.
Satoshis round **up** with integers: `ceil(inrPaise × 100000000 / paisePerBtc)`.
At ₹5,734,210.55/BTC, 25,000 paise costs **4,360 satoshis**.

Example immutable `payment` shared by HTTP, history and live events:

```json
{
  "id": "pay_0123456789abcdef0123456789abcdef",
  "orderId": "ord_0123456789abcdef0123456789abcdef",
  "status": "confirmed", "failureCode": null,
  "customer": { "id": "cus_0123456789abcdef0123456789abcdef", "displayName": "Ravi" },
  "merchant": { "id": "mer_fedcba9876543210fedcba9876543210", "businessName": "Chai Point" },
  "inrPaise": 25000, "btcSats": "4360", "inrPerBtc": "5734210.55",
  "rateSource": "coingecko", "rateFetchedAt": 1794000000000,
  "reference": "Table 4", "createdAt": 1794000001000, "confirmedAt": 1794000001000,
  "version": 1, "settlement": "SIMULATED", "label": "SIMULATED BTC → INR SETTLEMENT"
}
```

Both phones get identical persistent receipts, including payment/order IDs and names
captured at settlement. Debit, credit, four balanced postings, receipt, audit and
outbox commit together. DEMO BTC balances customer debit/system credit separately
from DEMO INR system debit/merchant credit. BTC and INR are never summed together.

## Errors and retries

Errors: `{ "error": "stable_code", "message": "text" }`; branch on `error`.

| HTTP | Codes |
| --- | --- |
| 400 | `bad_request`, `bad_name`, `bad_amount`, `bad_idempotency_key`, `bad_pagination` |
| 401 | `no_identity`, `unauthorized`, `session_expired`, `bad_credentials` |
| 402 | `insufficient_funds` |
| 403 | `self_payment`, `bad_origin` |
| 404 | `no_account`, `merchant_not_found`, `request_not_found`, `quote_not_found`, `payment_not_found` |
| 409 | `merchant_exists`, `rate_stale`, `quote_used`, **`request_paid`**, `balance_limit` |
| 410 | `request_expired`, `quote_expired` |
| 422 | `idempotency_conflict` (committed key belongs to another quote) |
| 429 | `rate_limited` (gateway), `login_limited` (merchant sign-in) |
| 503 | `rate_unavailable`; startup/database readiness may return `unavailable` |
| 500 | `internal`; retry uncertain payment outcomes with the same key |

Keys are scoped to customers and kept with receipts indefinitely (at least 24 hours).
The same committed key/quote replays its receipt even after quote expiry. A different
key cannot consume a used quote. Different customers can reuse a key. A rejected
transaction consumes neither key nor quote; retries still obey expiry/funds checks.
Persist one key per quote until resolved; never display success before `confirmed`.
Sign-in throttles after five failed attempts per IP or merchant in 15 minutes,
persisted across restarts. Recovery needs the original owning player identity;
a merchant session cannot recover it. A lost guest secret cannot be recovered.

## QR, live notifications and reconnects

QR: `https://<frontend-origin>/pay.html#/r/<code>` or `omenpay:r/<code>`.
Codes match `^[A-Za-z0-9_-]{6,64}$`. The frontend renders/scans QR codes and trusts
only its origin/scheme. Codes contain no credential or authoritative amount. B2
does not implement a payment page or camera interface.

Socket.IO namespace **`/btcinr`**, same origin, supports websocket and polling:

```js
io('/btcinr', { transports: ['websocket', 'polling'], auth: { customerToken } });
io('/btcinr', { auth: { merchantSession: token } });
// For same-origin cookies: auth:{role:'customer'} (World ID) or {role:'merchant'}.
// Omit role to allow both enrolled identities; both explicit credentials can coexist.
```

Bad credentials yield `connect_error` message `unauthorized`. Browser origins must
match the gateway or `ALLOWED_ORIGIN`. No client packet joins arbitrary private rooms,
moves funds, changes balances or confirms a payment.

| Server event | Payload |
| --- | --- |
| `btcinr:payment` | `{settlement,label,payment}`; same receipt only to payer/payee |
| `btcinr:balance` | `{settlement,label,role,balance,version}`; `btcSats` for customer or `inrPaise` for merchant |
| `btcinr:session-expired` | `{error:"session_expired"}` followed by disconnect |

Ignore older/equal balance versions and deduplicate receipts by `(id,version)`.
Revocation disconnects affected sockets; expiry/disablement is checked before each
delivery and periodically every 10 seconds. Refetch balance/history after sign-in.

The transactional outbox contains committed notifications. Failed publication remains
pending and retries every second and on new payments. Publication may repeat if
socket emission succeeds but its database acknowledgement fails. Publication means
gateway emission, **not device receipt**. Every (re)connect must reread the account
and first history page; poll those endpoints while disconnected. Missed socket
packets are recovered through HTTP receipts/balances, without settling again.
There is no durable per-device inbox or closed-app push. Keep one gateway instance:
Socket.IO fanout remains local, as in B1.
