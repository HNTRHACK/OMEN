# BTC → INR two-phone payment: frontend API requirements

**Status: PROPOSED v0.1, waiting for Codex (backend owner) to confirm or amend.**
Frontend owner: Claude. Backend owner: Codex (APIs, PostgreSQL ledger, WebSockets, auth).

The frontend (`pay.html`, `src/btcinr/`) is built against this document. Every path, event name,
status and error code it uses is in **one file**: `src/btcinr/contract.js`. If the backend
changes anything here, that file is the only thing the frontend needs to change.

The browser test `e2e/btcinr-phones.mjs` runs against a stub of this contract
(`e2e/stubs/btcinr-stub.mjs`). Run it with `BTCINR_REAL=1` to point it at the real backend
instead; that makes it the integration acceptance test once the backend exists.

## 1. Ground rules

- **Everything is simulated.** The UI labels every screen "SIMULATED BTC → INR SETTLEMENT".
  - Demo BTC isn't real bitcoin, and demo INR isn't real rupees.
  - There is no blockchain transaction and no UPI or bank transfer.
  - Responses must never contain a transaction hash, UTR, bank reference or anything that looks like one.
- **The server is authoritative.** The client validates input for friendliness only. Balances, quotes, limits and settlement are decided by the backend.
- **Money is integers.**
  - `inrPaise` is a JSON integer.
  - `btcSats` is a decimal **string** of an integer, because satoshi totals can exceed what JS numbers handle safely.
  - Rates are decimal strings (`"5734210.55"` INR per 1 BTC).
  - The frontend never does floating-point maths on money.
- **Timestamps** are epoch milliseconds (integers), matching the rest of the OMEN API.
- **Errors** use the existing OMEN envelope, `{ "error": "<code>", "message": "<human text>" }`, with a meaningful HTTP status. The frontend branches on `error`, never on `message`.
- **Success only means `confirmed`.** The frontend shows success only when a payment's `status` is `"confirmed"`.

## 2. Authentication: two separate credentials

| Role | Credential | Sent as |
|---|---|---|
| Customer (Phone A) | The existing OMEN guest identity (256-bit secret in `localStorage["omen.identity"]`; World ID later) | `x-omen-token: <hex>` |
| Merchant (Phone B) | A merchant session issued by the backend after merchant sign-up or sign-in | `Authorization: Bearer <session token>` |

- A customer token must never authorize merchant routes, and a merchant session must never authorize customer routes.
- One device may hold both credentials, and they stay independent.
- The frontend stores the merchant session in `localStorage["omen.btcinr.merchant"]` so a refresh keeps the merchant signed in.
- Sign-out deletes it locally and calls `DELETE /api/btcinr/merchant/session`.
- **Proposal:** an httpOnly cookie would be safer. If the backend prefers cookies, say so, and the frontend will send `credentials: "same-origin"` and stop storing the token.

Expired or invalid sessions return `401 { error: "session_expired" | "unauthorized" }`. The frontend then goes back to sign-in.

## 3. REST endpoints (all JSON, same origin, prefix `/api/btcinr`)

### Customer

**`GET /api/btcinr/customer`** (`x-omen-token`)
Returns `200 { customer }`. If the identity has no account yet, returns `404 { error: "no_account" }`.

**`POST /api/btcinr/customer`** `{ displayName }` (`x-omen-token`)
- Creates the account once and funds the demo BTC balance; the backend decides the amount.
- Calling it again updates `displayName` and never re-funds.
- Returns `200 { customer }`.
- `displayName` is 2–24 characters, trimmed; the backend moderates it.

```json
"customer": { "id": "cus_…", "displayName": "Ravi", "balance": { "btcSats": "1000000" }, "createdAt": 1793971110614 }
```

**`GET /api/btcinr/rate`** (public)
```json
{ "pair": "BTC/INR", "inrPerBtc": "5734210.55", "source": "coingecko", "fetchedAt": 1793971100000, "stale": false, "maxAgeMs": 120000 }
```
- `stale: true` means the cached rate is older than `maxAgeMs`.
- `503 { error: "rate_unavailable" }` means no usable rate. The frontend shows a red "rate unavailable" state and won't ask for a quote.

**`GET /api/btcinr/requests/:code`** (`x-omen-token`) is what the customer sees after scanning.
```json
{ "request": { "code": "rq_8f2k…", "merchant": { "id": "mer_…", "businessName": "Chai Point" }, "inrPaise": 25000, "reference": "Table 4", "expiresAt": null } }
```
- `inrPaise: null` means the customer types the amount; a number means the merchant fixed it and the customer confirms.
- Errors: `404 request_not_found`, `410 request_expired`.

**`POST /api/btcinr/quotes`** `{ requestCode, inrPaise }` (`x-omen-token`)
- If the request has a fixed amount, `inrPaise` must equal it.
- Returns `201 { quote }`.

```json
"quote": { "id": "qt_…", "requestCode": "rq_…", "merchant": { "id": "mer_…", "businessName": "Chai Point" },
  "inrPaise": 25000, "btcSats": "4360", "inrPerBtc": "5734210.55", "rateSource": "coingecko",
  "rateFetchedAt": 1793971100000, "createdAt": 1793971110000, "expiresAt": 1793971170000 }
```
- A quote is single-use and tied to this customer and request, and it fixes both amounts.
- The frontend expects a validity of about 60 s and counts down to `expiresAt`.
- Errors:
  - `400 bad_amount` (≤ 0, too big, or doesn't match a fixed amount)
  - `409 rate_stale`
  - `503 rate_unavailable`
  - `404 request_not_found`
  - `410 request_expired`
  - `403 self_payment` (a merchant paying their own request)

**`POST /api/btcinr/payments`** `{ quoteId }` with the header **`Idempotency-Key: <uuid v4>`** (`x-omen-token`)
- If the ledger commits synchronously, returns `201 { payment }` with `status: "confirmed"`.
- If not, returns `202 { payment }` with `status: "pending"`, and the final state arrives by WebSocket and `GET`.
- Replay rules:
  - **Same key and same body:** return the original payment (`200`, may include `"replayed": true`). Never debit twice.
  - **Same key, different body:** `422 idempotency_conflict`.
- Other errors:
  - `402 insufficient_funds`
  - `410 quote_expired`
  - `409 quote_used`
  - `429 rate_limited`
- Keys are scoped to the customer and kept for at least 24 h.

**`GET /api/btcinr/payments/:id`** is readable by the payer's token or the payee's merchant session only, and returns `{ payment }`.

**`GET /api/btcinr/payments?role=customer|merchant&limit=20&before=<cursor>`** returns persistent history, newest first: `{ payments: [...], nextCursor: string|null }`.

### Merchant

**`POST /api/btcinr/merchants`** `{ businessName, displayName }` (sign-up, no auth)
```json
{ "merchant": { … }, "session": { "token": "…", "expiresAt": 1794575910614 }, "accessCode": "K7QF-2M9X-PL4D" }
```
`accessCode` is shown **once**. With `merchant.id` it signs the merchant in on another device or after sign-out. The backend stores only a hash.

**`POST /api/btcinr/merchant/session`** `{ merchantId, accessCode }` returns `200 { merchant, session }` or `401 bad_credentials`. It should be rate-limited.

**`DELETE /api/btcinr/merchant/session`** (Bearer) returns `204`.

**`GET /api/btcinr/merchant`** (Bearer)
```json
{ "merchant": { "id": "mer_…", "businessName": "Chai Point", "displayName": "Asha", "balance": { "inrPaise": 0 }, "receiveCode": "rq_static_…" } }
```
`receiveCode` is the merchant's permanent "any amount" request.

**`POST /api/btcinr/merchant/requests`** `{ inrPaise, reference }` (Bearer) creates a QR with a fixed amount: `201 { request }`. `reference` is optional, up to 40 characters.

### Payment object

```json
{
  "id": "pay_…", "orderId": "ord_…", "status": "pending|confirmed|failed", "failureCode": null,
  "customer": { "id": "cus_…", "displayName": "Ravi" },
  "merchant": { "id": "mer_…", "businessName": "Chai Point" },
  "inrPaise": 25000, "btcSats": "4360", "inrPerBtc": "5734210.55",
  "rateSource": "coingecko", "rateFetchedAt": 1793971100000,
  "reference": "Table 4", "createdAt": 1793971110614, "confirmedAt": 1793971110700,
  "version": 2, "settlement": "SIMULATED"
}
```

- `version` increases on every change, and the frontend ignores updates older than what it already has.
- `settlement` is always `"SIMULATED"`.
- There is **no** hash, UTR or bank field.
- Both phones show the same `id` and `orderId` on the receipt.

## 4. Realtime (Socket.IO namespace `/btcinr`, same origin)

The client connects with `transports: ["websocket", "polling"]` and the handshake `auth`:
```json
{ "customerToken": "<x-omen-token or omitted>", "merchantSession": "<bearer or omitted>" }
```
A bad credential is rejected with `connect_error` `"unauthorized"`. The server puts the socket in that customer's and/or that merchant's rooms.

| Server → client event | Payload | When |
|---|---|---|
| `btcinr:payment` | `{ payment }` (full object, with `version`) | Any change to a payment where this socket is payer or payee |
| `btcinr:balance` | `{ role: "customer"\|"merchant", balance: { btcSats }\|{ inrPaise }, version }` | After every ledger change to that account |

- Delivery is at-least-once, and the client de-duplicates by `(id, version)`.
- After every (re)connect the client re-reads `GET customer` or `GET merchant` and the first page of history, so the server doesn't need to replay missed events.
- **Client fallback:** while the socket is down, the client polls those same endpoints every 4 s. This is extra resilience, not a substitute for the socket.

## 5. What the frontend guarantees

- It generates one `Idempotency-Key` per quote, keeps it in `sessionStorage` until the payment resolves, and reuses it for every retry, including after a refresh.
- It disables "Confirm" the moment it's pressed, so a double-tap sends at most one request.
- If a `POST /payments` response is lost (timeout or network error), it shows "checking…" and re-sends the same key. It never shows success and never sends a new key for the same quote.
- It never shows success unless `status === "confirmed"`. `pending` shows a waiting state, and `failed` shows the `failureCode`.
- It refuses to confirm a quote past its `expiresAt`, or while the rate is `stale` or unavailable. The backend must enforce these rules too.
- It treats only its own origin's QR codes (or the `omenpay:` scheme) as payment requests, and warns on anything else.

## 6. QR payload

The merchant phone renders `https://<origin>/pay.html#/r/<code>`. Any phone camera can open it, and the in-app scanner understands it. `omenpay:r/<code>` is also accepted. `<code>` matches `^[A-Za-z0-9_-]{6,64}$`. The QR carries no amount; the amount always comes from `GET /requests/:code`.

## 7. Questions for Codex

1. What initial demo BTC balance and per-payment INR cap do you want? The frontend shows whatever the server returns.
2. Is there a quote validity and staleness threshold you prefer over 60 s and 120 s?
3. Do you want cookie sessions for merchants instead of a bearer token (see §2)?
4. Is the namespace `/btcinr` OK alongside `/world` and `/merchant`?
5. Can you add a way, outside production, to force `rate_stale` or `rate_unavailable` for demos and tests?
6. True web push while the app is closed needs a service worker and VAPID keys on your side. In-app WebSocket notifications cover the demo. Do you want push later?
