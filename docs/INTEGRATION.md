# Stablerails — Integration Guide

How to accept USDT (TRC-20, Tron) payments with Stablerails from your own
application: create an invoice, show the buyer a checkout, and learn when it is
paid — via polling **or** signed webhooks.

> Audience: developers integrating the payment API. For running/operating the
> service itself see [`../README.md`](../README.md) and
> [`runbook-sweep.md`](./runbook-sweep.md).

- [Concepts](#concepts)
- [Authentication](#authentication)
- [Invoice lifecycle](#invoice-lifecycle)
- [1. Create an invoice](#1-create-an-invoice)
- [2. Show the checkout](#2-show-the-checkout)
- [3a. Learn the result — polling](#3a-learn-the-result--polling)
- [3b. Learn the result — webhooks](#3b-learn-the-result--webhooks)
- [Verifying webhook signatures](#verifying-webhook-signatures)
- [Other invoice operations](#other-invoice-operations)
- [Errors](#errors)
- [Managing the service (MCP / CLI)](#managing-the-service-mcp--cli)

---

## Concepts

- **Event** — a collection context (e.g. "New Year 2027"). Each event has its
  own payout wallet and HD derivation branch. Created by the operator (admin).
- **Invoice** — one expected payment. You create it with a **fiat price**; the
  service locks a USDT amount at creation time and assigns a **unique Tron
  deposit address** (HD, watch-only — the server never holds keys).
- **Payment** — an on-chain USDT transfer observed to a deposit address.

**Base URL** — your deployment, e.g. `https://pay.example.com`. All paths below
are relative to it. Examples use `$BASE_URL`.

**Money format** — all USDT amounts are **decimal strings with 6 decimals**
(`"2000.000000"`). `priceFiat` is a decimal string (`"2000.00"`); `fiatCurrency`
is an ISO 4217 code (`USD`, `RUB`, `EUR`, `IDR`). **Never parse money as a
float.**

**Network** — Tron / TRC-20 USDT only. Funds sent on any other network (ERC-20,
BEP-20, …) to a deposit address are **not** detected and are lost. The hosted
checkout shows a loud "TRC-20 only" warning; mirror it in your own UI.

---

## Authentication

All merchant API calls use a bearer key:

```
Authorization: Bearer <api-key>
```

Keys have a **scope** (capability hierarchy: `readonly < merchant < admin`):

| Scope | Can do |
|---|---|
| `readonly` | Read-only access to agent-facing GET endpoints: events, invoices, webhooks, api-keys metadata, sweep status. Rejected (403) by all write and admin routes. |
| `merchant` | Everything `readonly` can do **plus** create / cancel invoices |
| `admin` | Everything above **plus** manage events, webhooks, API keys, kill-switch |

Use a **`merchant`** key in your application backend. Keep an `admin` key only
for setup/management (creating events, registering webhooks). Use a `readonly`
key for AI agents / MCP clients — a leaked agent key then cannot mint keys,
move money, register webhooks, or prepare sweeps. The raw key is shown **once**
at creation — store it securely; the server keeps only a SHA-256 hash. Keys are
minted by the operator (see README "First-Run Bootstrap").

`401 UNAUTHORIZED` (no/invalid bearer) · `401 INVALID_API_KEY` (revoked) ·
`403 FORBIDDEN` (scope too low).

---

## Invoice lifecycle

```
                       ┌────────────► paid        (exact amount, at solid block)
 pending ──► payment_detected ───────► overpaid    (received > expected + tolerance)
    │                  └────────────► underpaid   (received < expected − tolerance)
    │
    ├──────────────────────────────► expired      (TTL elapsed, nothing received)
    └──────────────────────────────► canceled     (you cancelled a pending invoice)

 any terminal state ──(late on-chain funds within grace window)──► overdue
```

| Status | Meaning |
|---|---|
| `pending` | Created, awaiting funds. |
| `payment_detected` | A transfer was seen but not yet final (pre-solid-block). |
| `paid` | Settled in full at an **irreversible** Tron block. ✅ |
| `overpaid` | Settled, but received more than billed (+ tolerance). |
| `underpaid` | Funds arrived but less than billed (− tolerance). |
| `expired` | TTL elapsed with no funds. |
| `canceled` | Cancelled while still `pending`. |
| `overdue` | Late funds landed on an already-terminal invoice (grace window). |

A payment is only ever marked `paid` at **solid-block height** (Tron's
irreversible checkpoint) and only after **two independent RPC providers agree** —
there are no zero-confirmation credits and no reversals.

---

## 1. Create an invoice

`POST /v1/invoices` · scope `merchant`

```bash
curl -X POST "$BASE_URL/v1/invoices" \
  -H "Authorization: Bearer $MERCHANT_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-12345" \
  -d '{
        "eventId": "evt_abc123",
        "priceFiat": "2000.00",
        "fiatCurrency": "USD",
        "metadata": { "orderId": "12345", "buyer": "Egor", "tier": "adult" },
        "ttlMinutes": 30
      }'
```

| Field | Required | Notes |
|---|---|---|
| `eventId` | yes | Target event. |
| `priceFiat` | yes | Decimal string, e.g. `"2000.00"`. |
| `fiatCurrency` | yes | ISO 4217 (`USD`, `RUB`, …). |
| `metadata` | no | Arbitrary JSON — your order id, buyer, tier, etc. Returned on reads and filterable in list. |
| `ttlMinutes` | no | Invoice validity. Default **30**. Must be an integer between 1 and **1440** (24 h); non-integer or out-of-range → `400 TTL_OUT_OF_RANGE`. |
| `expiresInSeconds` | no | Alias for `ttlMinutes` (÷60, rounded up). `ttlMinutes` wins if both sent. Capped at `86400` (24 h). |

**`Idempotency-Key`** (header, optional but recommended): retrying the same key
with the **same body** returns the original response; a **different body** with
the same key → `409 IDEMPOTENCY_CONFLICT`. Keys are scoped per API key.

**`201 Created`:**

```json
{
  "data": {
    "id": "inv_9f2c…",
    "eventId": "evt_abc123",
    "status": "pending",
    "priceFiat": "2000.00",
    "fiatCurrency": "USD",
    "amountUsdt": "2000.000000",
    "amountReceived": "0.000000",
    "rateLockedAt": "2026-06-05T17:00:00.000Z",
    "network": "TRON",
    "depositAddress": "T…",
    "derivationIndex": 7,
    "expiresAt": "2026-06-05T17:30:00.000Z",
    "metadata": { "orderId": "12345", "buyer": "Egor", "tier": "adult" },
    "createdAt": "2026-06-05T17:00:00.000Z",
    "paidAt": null,
    "hostedUrl": "$BASE_URL/pay/inv_9f2c…"
  }
}
```

The two fields you act on: **`depositAddress`** (where the buyer sends exactly
`amountUsdt` in TRC-20 USDT) and **`hostedUrl`** (a ready-made checkout page).

Errors: `400 AMOUNT_TOO_SMALL` (priced amount below 0.01 USDT / 10 000 micro) ·
`404 EVENT_NOT_FOUND` · `422 VALIDATION_ERROR` (bad price/currency) ·
`429 RATE_LIMITED` · `503 SERVICE_PAUSED` (operator kill-switch).

---

## 2. Show the checkout

Two options:

1. **Hosted checkout (simplest):** redirect the buyer to `hostedUrl`
   (`$BASE_URL/pay/{invoiceId}`). It renders a QR code, the exact USDT amount, a
   countdown, the "TRC-20 only" warning, and live status — no work on your side.
   The page is per-IP rate-limited (AUTH-2); it returns `429` on excess requests.
2. **Your own UI:** display `depositAddress` + `amountUsdt` + a TRC-20 warning
   yourself, and drive status from the public polling endpoint below.

---

## 3a. Learn the result — polling

For an unauthenticated, checkout-friendly status (safe to call from a browser):

`GET /v1/public/invoices/:id` · no auth · rate-limited per client IP

```json
{
  "data": {
    "id": "inv_9f2c…",
    "status": "paid",
    "amountUsdt": "2000.000000",
    "depositAddress": "T…",
    "expiresAt": "2026-06-05T17:30:00.000Z",
    "network": "TRON",
    "paidAt": "2026-06-05T17:06:12.000Z"
  }
}
```

For full server-side detail (payments + confirmations), use the authenticated
read in [Other invoice operations](#other-invoice-operations). Poll every few
seconds; treat `paid` / `overpaid` / `underpaid` / `expired` / `canceled` as
terminal for UI purposes (but see `overdue` — late funds can still arrive).

---

## 3b. Learn the result — webhooks

Webhooks are the push alternative to polling. **Registering endpoints is an
admin operation** (do it once at setup).

### Register an endpoint

`POST /v1/webhooks` · scope `admin`

```bash
curl -X POST "$BASE_URL/v1/webhooks" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://yourapp.com/hooks/stablerails", "eventId": "evt_abc123" }'
```

| Field | Required | Notes |
|---|---|---|
| `url` | yes | HTTPS endpoint. Validated at registration time: must use `https://` and must pass the SSRF pre-screen (private, loopback, link-local, and cloud-metadata IPs are rejected); failures return `400 INVALID_URL`. (Outbound delivery is also SSRF-guarded with real undici DNS pinning — connection pinned to the pre-validated IP to defeat DNS-rebinding attacks.) |
| `eventId` | no | Scope to one event. Omit → receive events for **all** events. |
| `secret` | no | Your signing secret. Omitted → a random one is generated. |

**`201`** returns the endpoint including its **`secret`** — shown **only here**.
Store it; you need it to verify signatures. (List/Get never return the secret.)

### Event types

`invoice.payment_detected` · `invoice.paid` · `invoice.overpaid` ·
`invoice.underpaid` · `invoice.expired` · `invoice.canceled` ·
`invoice.late_funds` (an `overdue` transition).

### Delivery payload

`POST` to your URL, `Content-Type: application/json`:

```json
{
  "eventUid": "invoice.paid:inv_9f2c…:wh_7a1…:1",
  "eventType": "invoice.paid",
  "version": 1,
  "event": "invoice.paid",
  "invoiceId": "inv_9f2c…",
  "status": "paid",
  "amountReceived": "2000.000000",
  "timestamp": "2026-06-05T17:06:12.000Z"
}
```

Headers:

| Header | Purpose |
|---|---|
| `X-Stablerails-Signature` | `t=<unixSeconds>,v1=<hex-hmac>` — verify before trusting the body. |
| `X-Stablerails-EventUid` | Stable unique id of this event — **dedupe on it**. |

**Delivery semantics** — respond **`2xx`** to acknowledge. Anything else (or a
timeout) is retried with backoff + jitter: **1m, 5m, 30m, 2h, 6h, 12h, 24h ×3**,
then the delivery goes to a dead-letter queue (10 sends total, ~69h window).

**Idempotency & ordering** — delivery is **at-least-once**, so the same
`eventUid` may arrive more than once: make your handler idempotent (dedupe on
`eventUid`). `version` is **monotonic per (invoice, endpoint)** — if you persist
the last version seen for an invoice, ignore any delivery with a lower one.

**Treat webhooks as a trigger, not the source of truth.** On `invoice.paid`,
re-fetch `GET /v1/invoices/:id` with your merchant key and fulfil based on the
authoritative server state.

---

## Verifying webhook signatures

The signed payload is the string `` `${t}.${rawBody}` `` — where `t` is the
header's timestamp and `rawBody` is the **exact bytes** of the request body
(verify **before** JSON-parsing/re-serializing — a re-serialized body will not
match). HMAC-SHA256 with your endpoint `secret`, hex-encoded. Reject if the
timestamp is more than **300s** old.

**Node.js (Express):**

```js
import crypto from "node:crypto";
import express from "express";

const app = express();
const SECRET = process.env.STABLERAILS_WEBHOOK_SECRET;

// Capture the RAW body — required for signature verification.
app.post("/hooks/stablerails", express.raw({ type: "application/json" }), (req, res) => {
  const header = req.get("X-Stablerails-Signature") || "";
  const raw = req.body; // Buffer (raw bytes)

  const t = /(?:^|,)t=(\d+)/.exec(header);
  const v1 = /(?:^|,)v1=([0-9a-f]+)/.exec(header);
  if (!t || !v1) return res.status(400).end("malformed signature");

  const ts = Number(t[1]);
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    return res.status(400).end("stale");
  }

  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(`${ts}.${raw.toString("utf8")}`)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1[1], "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).end("bad signature");
  }

  const evt = JSON.parse(raw.toString("utf8"));
  // dedupe on evt.eventUid, then handle evt.eventType …
  res.status(200).end(); // ack
});
```

**Python (Flask):**

```python
import hmac, hashlib, time, re
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = "…"  # your endpoint secret

@app.post("/hooks/stablerails")
def stablerails_hook():
    header = request.headers.get("X-Stablerails-Signature", "")
    raw = request.get_data()  # raw bytes — do not use request.json here

    t = re.search(r"(?:^|,)t=(\d+)", header)
    v1 = re.search(r"(?:^|,)v1=([0-9a-f]+)", header)
    if not t or not v1:
        abort(400)

    ts = int(t.group(1))
    if abs(int(time.time()) - ts) > 300:
        abort(400)  # stale

    signed = f"{ts}.".encode() + raw
    expected = hmac.new(SECRET.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, v1.group(1)):
        abort(401)  # bad signature

    evt = request.get_json()
    # dedupe on evt["eventUid"], then handle evt["eventType"] …
    return "", 200
```

---

## Other invoice operations

**Get one (authoritative, with payments + confirmations)** —
`GET /v1/invoices/:id` · scope `merchant`:

```json
{
  "data": {
    "id": "inv_9f2c…",
    "status": "paid",
    "amountUsdt": "2000.000000",
    "amountReceived": "2000.000000",
    "metadata": { "orderId": "12345" },
    "paidAt": "2026-06-05T17:06:12.000Z",
    "hostedUrl": "$BASE_URL/pay/inv_9f2c…",
    "payments": [
      {
        "txHash": "…", "logIndex": 0, "network": "TRON",
        "fromAddress": "T…", "amountUsdt": "2000.000000",
        "blockNumber": "65000123", "status": "confirmed",
        "confirmations": 41,
        "detectedAt": "2026-06-05T17:05:30.000Z",
        "confirmedAt": "2026-06-05T17:06:12.000Z"
      }
    ],
    "confirmations": 41
  }
}
```

**List / search** — `GET /v1/invoices` · scope `merchant`. Query params:
`eventId`, `status`, `q` (free-text), `metadata.<key>=<value>` (e.g.
`?metadata.orderId=12345`), `cursor`, `limit` (default 20, max 100). Returns
`{ "data": [ …invoices ] }`.

**Cancel** — `POST /v1/invoices/:id/cancel` · scope `merchant`. Only a `pending`
invoice can be cancelled; otherwise `409`. `404` if not found.

---

## Errors

Every error response has the shape:

```json
{ "error": { "code": "EVENT_NOT_FOUND", "message": "…" } }
```

Non-500 framework errors (validation, not-found, etc.) return a generic `message`
string rather than an internal detail; the typed `code` field is always present and
is the reliable discriminant for programmatic handling.

| HTTP | Codes | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Missing required field. |
| 400 | `AMOUNT_TOO_SMALL` | Invoice `priceFiat` converts to less than 0.01 USDT (10 000 micro). |
| 400 | `INVALID_URL` | Webhook `url` is not `https://` or its resolved IP is private/loopback/link-local/metadata (SSRF pre-screen). |
| 400 | `TTL_OUT_OF_RANGE` | `ttlMinutes` is not an integer, is NaN, or is outside 1–1440; `expiresInSeconds` is outside 1–86400. |
| 401 | `UNAUTHORIZED`, `INVALID_API_KEY` | Missing / invalid / revoked key. |
| 403 | `FORBIDDEN` | Key scope too low (merchant calling admin route). |
| 404 | `EVENT_NOT_FOUND`, `NOT_FOUND` | Unknown event / invoice / webhook. |
| 409 | `IDEMPOTENCY_CONFLICT`, lifecycle codes | Idempotency-Key reused with new body; illegal state transition (e.g. cancel a paid invoice). |
| 422 | `VALIDATION_ERROR` | Bad amount / currency / arguments. |
| 429 | `RATE_LIMITED` | Per-key (or per-IP for public) rate limit. Back off and retry. |
| 503 | `SERVICE_PAUSED` | Operator kill-switch paused this surface. |

---

## Managing the service (MCP / CLI)

Beyond the HTTP API, the operator can manage everything **from Claude via MCP**
(Model Context Protocol) or a thin CLI — create events/invoices, list/find by
buyer or order, register webhooks, reconcile, and **prepare** sweeps.

```bash
npm run cli:mcp        # start the MCP server on stdio (point your MCP client at it)
```

Cashing out is **human-gated by design**: an AI agent can *prepare* a sweep
(build the unsigned transactions, server-side, no keys) but only a human
entering the seed passphrase at a real terminal can *sign and broadcast* it. The
sweep-execute step is intentionally **not** exposed as an MCP tool. See
[`runbook-sweep.md`](./runbook-sweep.md).

<!-- updated-by-superflow:2026-06-06 -->
