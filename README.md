# Stablerails

Free, open-source, self-hosted, non-custodial stablecoin payment software. USDT (TRC-20) on Tron today; Polygon/Ethereum/USDC on the roadmap. Watch-only server, local signer — 0% fees, the only cost is network gas.

The **server never holds keys** — all signing happens on the operator's local machine using the CLI or MCP server.

> **Integrating from your app?** See **[docs/INTEGRATION.md](docs/INTEGRATION.md)** — authentication, create-invoice, hosted checkout, status polling, and signed webhooks (with HMAC verification examples in Node.js and Python).

## Architecture

```
src/core/       Domain logic (invoice lifecycle, pricing, ports)
src/chain/      Tron adapter (address codec, transfer scan, solid block)
src/server/     HTTP API — watch-only, no signer imports
src/workers/    Block watcher + webhook delivery — watch-only
src/signer/     LOCAL ONLY — seed encryption, key derivation, sweep signing
src/cli/        Operator CLI (sweep prepare/execute, MCP server)
src/mcp/        MCP server — bridges CLI tools for AI agents
src/lib/        Shared utilities (HMAC, SSRF guard, rate-limit, kill-switch)
```

| Layer | Constraint |
|---|---|
| `src/server/` | **Never imports `src/signer/`** |
| `src/workers/` | **Never imports `src/signer/`** |
| `src/cli/`, `src/mcp/` | May import signer/chain |
| `src/core/` | No I/O — inject via ports |

## Security Model

A server breach moves **zero funds**:

- Private keys never enter `src/server` or `src/workers`
- Payment is marked `paid` only at Tron **solid-block** height (no 0-conf credits)
- Crediting is idempotent on `(network, txHash, logIndex)`
- Two independent RPC providers must agree before any credit (no single-node trust)
- Sweeps require a human passphrase on the operator's local machine
- SSRF guard on all outbound webhook POSTs (blocks RFC1918; real undici DNS pinning — connection pinned to pre-validated IP, fail-closed)

## Money Representation

All amounts are stored as decimal strings with 6 decimal places (micro-USDT).

```
1 USDT = "1.000000"
```

**Never use floats.** Internal bigint arithmetic uses micro-USDT (1 USDT = 1_000_000n).

## Environment Variables

### Server / Worker

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `TRON_RPC_PRIMARY_URL` | Yes (worker) | Primary Tron full-node URL (used by `src/workers`) |
| `TRON_RPC_SECONDARY_URL` | Yes (worker) | Secondary Tron full-node URL — must differ from primary and be on the same network |
| `TRON_RPC_PRIMARY_API_KEY` | No | API key for primary TronGrid node |
| `TRON_RPC_SECONDARY_API_KEY` | No | API key for secondary TronGrid node |
| `WATCHER_POLL_INTERVAL_MS` | No | Poll interval in ms (default: 5000) |
| `PUBLIC_BASE_URL` | No | Base URL for hosted checkout links |

### CLI / Signer (local operator machine)

| Variable | Required | Description |
|---|---|---|
| `STABLERAILS_ADMIN_KEY` | Yes (CLI) | Admin bearer key for API requests |
| `STABLERAILS_MCP_KEY` | No | `readonly` bearer key for the MCP server. Falls back to `STABLERAILS_ADMIN_KEY` if unset. Prefer a `readonly` key so a leaked agent key cannot write. |
| `STABLERAILS_API_URL` | No | Server base URL (default: `http://localhost:3000`) |
| `STABLERAILS_ENCRYPTED_SEED` | Yes (seed ops) | Encrypted seed blob JSON (inline) |
| `STABLERAILS_SEED_FILE` | Alt to above | Path to encrypted seed blob JSON file |
| `STABLERAILS_MAIN_WALLET` | Yes (`sweep execute`) | Locally-pinned destination address (`T...` Tron base58, 34 chars). Every sweep item's destination is hard-asserted against this value before signing. The entire sweep aborts on any mismatch — a server/DB compromise cannot redirect funds. Must be set and valid or `sweep execute` refuses to run. (SIGN-2) |
| `TRON_RPC_PRIMARY` | No | Tron node URL — enables live broadcast in `sweep execute` (absent = dry-run). When set, the signer refuses to sign a mock/stub transaction (SIGN-3). |
| `TRON_RPC_SECONDARY` | No | Fallback Tron node URL for sweep broadcast |

### Kill-switch (env flags — boot-time only)

These env flags are read at startup. Changing them requires a process restart.

| Variable | Effect |
|---|---|
| `STABLERAILS_PAUSE_INVOICES=1` | `POST /v1/invoices` returns 503 |
| `STABLERAILS_PAUSE_WATCHER=1` | Block watcher skips each poll tick |
| `STABLERAILS_PAUSE_WEBHOOKS=1` | Webhook delivery drain skips all rows |

**Runtime control (no restart):** use the admin API — DB-backed, cross-process (watcher + webhook drain pick up within ~1.5s):

```bash
# pause / resume
curl -X POST "$BASE_URL/v1/admin/killswitch" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"area":"invoices","paused":true}'

# check current state
curl "$BASE_URL/v1/admin/killswitch" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

## Setup

```bash
cp .env.example .env
# Set DATABASE_URL, TRON_RPC_PRIMARY_URL, TRON_RPC_SECONDARY_URL.
# Primary/secondary must be distinct endpoints on the same network.

npm install
npx prisma migrate deploy   # apply baseline DDL (prisma/migrations/0000000000000_init + any later migrations)
npm run build               # prisma generate + tsc
```

### Docker Compose

```bash
cp .env.docker.example .env
# Fill two distinct same-network TRON_RPC_*_URL values before starting the worker.
docker compose up --build
```

`docker-compose.yml` treats `.env` as optional so `docker compose config` works before local bootstrap. With no RPC URLs the worker fails fast instead of mixing networks. The demo page is disabled by default, never mounts in production runtime, and is additionally localhost-only when enabled for local development.

## npm Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server (tsx watch) |
| `npm run worker` | Start block watcher + webhook delivery worker |
| `npm run cli:mcp` | Start MCP server on stdio transport (dev, via tsx) |
| `npm run build` | `prisma generate && tsc` |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (offline — no DB required) |
| `npx tsx scripts/verify-signer-isolation.ts` | Audit server/workers→signer boundary |

## First-Run Bootstrap (clean database)

Before the quick-start you need **one operator account** and **one admin API key**. Run these steps in order on a clean DB:

```bash
# ── Step 1: create the first operator (direct DB; no admin key exists yet) ───
DATABASE_URL="postgres://..." \
  npx tsx src/cli/index.ts operator init --email admin@example.com
# TTY gate: prompts for password + confirmation (hidden input)

# ── Step 2: encrypt your seed ─────────────────────────────────────────────────
npx tsx src/cli/index.ts seed init
# Prompts for mnemonic (or press Enter to generate) + passphrase + confirmation
# Writes encrypted blob — set STABLERAILS_ENCRYPTED_SEED or STABLERAILS_SEED_FILE

# ── Step 3: start the server ──────────────────────────────────────────────────
DATABASE_URL="postgres://..." npm run dev

# ── Step 4: mint the first admin key (browser or curl) ───────────────────────
# Browser: http://localhost:3000/login → log in → http://localhost:3000/api-keys
#
# Or via curl (cookie-jar flow — session id is in the HttpOnly cookie, not the body):
curl -s -c /tmp/up_cookies \
  -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"<your-password>"}' \
  | jq .
# The response now returns only { data: { email } } — the session is in the cookie jar.
# Use the saved cookie jar to mint the first admin key:
curl -s -b /tmp/up_cookies \
  -X POST http://localhost:3000/v1/api-keys \
  -H "Content-Type: application/json" \
  -d '{"label":"main-admin","scope":"admin"}' \
  | jq .
# The raw key is shown ONCE — copy it immediately.

# ── Step 5: export the admin key ──────────────────────────────────────────────
export STABLERAILS_ADMIN_KEY="<raw-key-from-step-4>"
export STABLERAILS_ENCRYPTED_SEED='{"ciphertext":"...","salt":"...","iv":"...","tag":"..."}'
```

## Quick Start: create event → invoice → checkout → sweep

### 1. Create an event (passphrase-gated CLI)

> Requires `STABLERAILS_ADMIN_KEY` and `STABLERAILS_ENCRYPTED_SEED` from the bootstrap above.

```bash
# The CLI derives the xpub locally from your encrypted seed — no raw xpub needed.
export STABLERAILS_ADMIN_KEY="your-admin-key"
export STABLERAILS_ENCRYPTED_SEED='{"ciphertext":"...","salt":"...","iv":"...","tag":"..."}'

npx tsx src/cli/index.ts event create \
  --name "My Event" \
  --main-wallet T...
# Prompts for seed passphrase interactively (TTY gate)
```

> **Advanced / manual**: if you already have the xpub, you can POST directly:
> ```bash
> curl -X POST http://localhost:3000/v1/events \
>   -H "Authorization: Bearer $STABLERAILS_ADMIN_KEY" \
>   -H "Content-Type: application/json" \
>   -d '{"name":"My Event","mainWalletAddress":"T...","derivationAccount":0,"xpubAccount":"xpub..."}'
> ```

### 2. Create an invoice (merchant key)

```bash
curl -X POST http://localhost:3000/v1/invoices \
  -H "Authorization: Bearer $MERCHANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_...","priceFiat":"100.00","fiatCurrency":"USD"}'
# Response includes depositAddress and hostedUrl for the checkout page
```

### 3. Checkout

Direct the payer to `hostedUrl` (e.g. `https://pay.example.com/pay/{invoiceId}`).
The watcher polls TronGrid for USDT transfers; once both providers agree at solid-block height the invoice transitions to `paid`.

### 4. Sweep (with passphrase)

```bash
# Step 1 — prepare: build unsigned txs server-side (no signing, no passphrase)
npx tsx src/cli/index.ts sweep prepare --event evt_...
# Prints a SweepIntent id, e.g. sw_abc123

# Step 2 — execute: sign locally and broadcast
# SIGN-2: requires STABLERAILS_MAIN_WALLET to be set to your destination address.
# Every item's destination is pinned to this value before signing; the whole
# sweep aborts on any mismatch. The operator must confirm the destination at
# the TTY (y/N) before the passphrase prompt.
export STABLERAILS_MAIN_WALLET=T...   # your main wallet Base58 address

# Without TRON_RPC_PRIMARY: dry-run (sign only, NOT broadcast — safe for testing)
npx tsx src/cli/index.ts sweep execute --intent sw_abc123
# Prompts: confirm destination y/N, then: Enter seed passphrase (hidden):

# With TRON_RPC_PRIMARY set: live broadcast
# SIGN-3: on the live path the signer refuses to sign a mock/stub transaction.
# Live broadcast requires wiring a real triggerSmartContract node call first
# (go-live operator step — see docs/runbook-sweep.md).
TRON_RPC_PRIMARY=https://api.trongrid.io \
  npx tsx src/cli/index.ts sweep execute --intent sw_abc123
```

> **Dry-run is automatic**: `sweep execute` signs locally and prints txIDs when `TRON_RPC_PRIMARY` is unset. No `--dry-run` flag exists — absent env var is the gate.

See `docs/runbook-sweep.md` for full sweep operator guidance.

## Dual Deny-List & Security Notes

1. **Server boundary**: `import/no-restricted-paths` ESLint rule (`.eslintrc.cjs`) enforces that `src/server` and `src/workers` cannot import `src/signer` at build time.
2. **Kill-switch**: env flags `STABLERAILS_PAUSE_*` (boot-time; require restart) + runtime DB-backed admin routes `POST /v1/admin/killswitch` / `GET /v1/admin/killswitch` (admin scope, cross-process) — see `src/server/killswitch.ts`.
3. **Security headers / CSP (SEC-3)**: `@fastify/helmet` is registered globally. HTML routes (`/login`, `/api-keys`, `/pay/:id`) add a nonce-based CSP locking `script-src` to a per-request nonce. JSON API routes do not send CSP (no HTML served).
4. **Invoice TTL cap (SEC-2)**: `POST /v1/invoices` caps `ttlMinutes` at **1440** (24 h). Non-integer, NaN, or out-of-range `ttlMinutes`/`expiresInSeconds` returns `400 TTL_OUT_OF_RANGE`.

## Audit Notes: npm audit

`npm audit --audit-level=high` is the CI gate. Residual **low-severity** advisories in transitive dependencies of `tronweb` (e.g. `elliptic`, `ethers`) have been reviewed:

- They are in the `tronweb` signing path which runs **only** in `src/signer/` (offline, local machine)
- They are **not** reachable from `src/server/` or `src/workers/` at runtime
- A hardened follow-up is `audit-ci` with a per-advisory allowlist

## Known Limitations / Go-Live Steps

- No live broadcast without `TRON_RPC_PRIMARY` set — sign-only mode is safe offline
- **`STABLERAILS_MAIN_WALLET` required for `sweep execute`** — set to your main wallet's `T...` Base58 address before sweeping (SIGN-2)
- **Live broadcast is intentionally gated (SIGN-3)**: when `TRON_RPC_PRIMARY` is set the signer refuses to broadcast a mock/stub transaction (one with empty `raw_data.contract`). Go-live step: wire the real `triggerSmartContract` call on a Tron full node so the tx object has a real `raw_data` and txID; the `assertNotMockTxIdOnLivePath` + `verifyTxIdMatchesRawData` guards then pass
- Real seed phrases and Hetzner/VPS deployment are human-operator steps
- The MCP server (`npm run cli:mcp`) requires a compiled binary for production use
- Holistic-consolidation TODOs are tracked in BACKLOG items

<!-- updated-by-superflow:2026-06-06 -->
