# Stablerails — Claude Instructions

## What it is

Self-hosted, non-custodial stablecoin payment software — USDT (TRC-20): watch-only HTTP server + local signer.
The server never holds keys; sweeps require a human passphrase on the operator's machine.

## Key Directories / Files

| Path | Purpose |
|---|---|
| `src/core/ports.ts` | All domain ports (inject, never import chain/db here) |
| `src/core/invoices.ts` | `createInvoice` — pure, no I/O |
| `src/core/lifecycle.ts` | Invoice state machine `transitionInvoice` — pure |
| `src/core/pricing.ts` | Fiat → micro-USDT conversion + tolerance band |
| `src/chain/tron/` | Tron address codec, transfer scan, solid block fetch, receipt scan |
| `src/chain/tron/receiptScan.ts` | `fetchTransactionReceipt` + `parseUsdtReceiptTransfers` — authoritative credit source |
| `src/chain/tron/broadcast.ts` | Keyless broadcast + `triggerSmartContract` node call (dup-broadcast = success) |
| `src/server/app.ts` | Fastify app factory (inject all deps) |
| `src/server/routes/invoices.ts` | `POST /v1/invoices` (kill-switch wired here) |
| `src/server/killswitch.ts` | `isPaused(area)` / `pauseArea` / `resumeArea` |
| `src/workers/watcher.ts` | `TronWatcher` — poll loop, two-RPC agreement |
| `src/workers/webhookDelivery.ts` | `drainPending` — HMAC-signed POST + retry |
| `src/workers/db/inMemoryWebhookDeliveryRepo.ts` | In-memory webhook repo for tests |
| `src/signer/` | Seed encrypt/decrypt, key derivation, sweep signing (LOCAL ONLY) |
| `src/lib/hmac.ts` | HMAC-SHA256 sign + verify |
| `src/lib/ssrf-guard.ts` | Outbound SSRF guard (blocks RFC1918, real undici DNS pinning — WH-1) |
| `src/lib/decimal.ts` | `parseMicro` / `formatMicro` (bigint ↔ decimal string) |
| `src/cli/` | Operator CLI (`sweep prepare`, `sweep execute`) |
| `src/mcp/` | MCP server bridging CLI tools for AI agents |
| `tests/integration/` | End-to-end offline integration tests |
| `prisma/schema.prisma` | Database schema |

## Conventions

- **Money**: all amounts are micro-USDT bigint (6 decimals). `1 USDT = 1_000_000n`. Never use floats. Stored as decimal string `"1.000000"`. Minimum invoice amount is **0.01 USDT** (10 000 micro); `POST /v1/invoices` rejects anything below with `400 AMOUNT_TOO_SMALL` (MONEY-3).
- **User-facing messages**: Russian
- **Code, comments, variables**: English
- **`paid` only at solid block**: two independent checks required. (1) Finality fence: `latestSolidBlock = min(primarySolid, secondarySolid)` — the most conservative agreed solid height. (2) Per-tx block agreement (WATCH-1): `effectiveBlockNumber = max(primaryBN, secondaryBN)` where both BNs come from receipt parsing via `gettransactioninfobyid`; a payment is credited toward `paid` only when `effectiveBlockNumber <= latestSolidBlock`, i.e. BOTH providers place the tx at/below solid. If either provider returns no receipt, or their receipts disagree on amount/address, the candidate is SKIPPED entirely this tick (no "detected" placeholder for unconfirmed txs). Recovers on the next tick. Never 0-conf.
- **Server↛signer boundary**: `src/server/**` and `src/workers/**` MUST NOT import `src/signer/**` (enforced via ESLint `import/no-restricted-paths`).
- **Watch-only / local-signing**: signing only in `src/signer/`, triggered by operator CLI with TTY passphrase gate.
- **Sweep destination pin (SIGN-2 / SIGN-2b)**: `sweep execute` requires `STABLERAILS_MAIN_WALLET` (Tron Base58, `T...`, validated with the full Base58Check checksum via `isValidBase58Address` — a charset-valid typo is rejected). SIGN-2: every item's `toAddressBase58` is hard-asserted against this local value. **SIGN-2b — the bytes that actually get signed**: the server-provided `toAddressHex` / `callData` / `feeLimitSun` are NOT trusted. The transfer is **recomputed locally** from the pin + `amountMicroStr` via `buildTransfer`; the server-provided `toAddressHex`/`callData` are asserted to match (case-insensitive hex), `feeLimitSun` is bounds-checked (`1..1_000_000_000` SUN = max 1000 TRX, anti fee-burn), and **only the locally-derived bytes enter the signable tx** (server values are advisory display). A compromised server that shows the pinned address but encodes an attacker destination/amount in `callData` is rejected. The whole sweep aborts on any mismatch. Operator confirms the destination at the TTY before the passphrase prompt. Implemented in `src/cli/commands/sweep.ts` (`getMainWalletPin`, `toSignerIntentWithPin`).
- **Live sweep trigger (SIGN-3, go-live wired)**: when `TRON_RPC_PRIMARY_URL` (canonical; legacy `TRON_RPC_PRIMARY` also accepted) is set, `sweep execute` builds each real tx via the node's `POST /wallet/triggersmartcontract` (`src/chain/tron/broadcast.ts#triggerSmartContract`) from LOCALLY-derived bytes, then verifies the node response in `verifyNodeTransaction` (`src/cli/commands/sweep.ts`): txID = sha256(raw_data_hex), tronweb `txCheck` JSON↔bytes binding, exactly one `TriggerSmartContract` with locally-expected owner/contract/callData, `call_value` must be 0 (anti TRX-drain), fee_limit must equal the validated value. ALL node txs are built + verified BEFORE anything is signed; any deviation aborts the whole sweep. `assertNotMockTxIdOnLivePath` (`src/signer/sign.ts`) additionally refuses mock/stub txs on the live path. Dup-broadcast (`DUP_TRANSACTION_ERROR`) is treated as success (tx already on-chain exactly once). Dry-run (no live RPC env) signs locally and never posts broadcast-result.
- **Keychain / Touch ID (macOS, opt-in)**: `seed keychain enable|disable|status` stores the seed passphrase in the macOS Keychain (service `stablerails-seed`); the entry itself is the opt-in marker. At signing time `promptSeedPassphrase` (`src/cli/prompt.ts`) keeps the full TTY gate (`process.stdin.isTTY === true` checked FIRST), then — darwin only, entry present — requires a fresh Touch ID success before reading the Keychain. Policy is `.deviceOwnerAuthenticationWithBiometrics` (biometrics ONLY — no macOS-password fallback dialog, which would weaken the gate to "knows the Mac password"); the biometric prompt is the human-presence check in this mode. **Fail-closed**: biometrics unavailable/failed/helper-missing → the Keychain is NOT read; fall back to the typed passphrase prompt. `STABLERAILS_NO_KEYCHAIN=1` forces typed mode. The passphrase never appears in argv (writes go via `security -i` stdin; stores are read-back verified). The Swift Touch ID helper compiles on first use to `~/.stablerails/bin/stablerails-biometric-<src-hash>` (0700). `enable` verifies the passphrase decrypts the configured encrypted seed before storing.
- **Tests offline**: all tests use in-memory repos + mock RPC clients. No `DATABASE_URL` required.
- **Mainnet-scale fixtures**: block numbers in tests use `83_000_000n` solid (real Tron mainnet ~June 2025). Never use tiny values like `100n` — they hide the M-1 class of timestamp-derivation bug.
- **Two-RPC agreement (receipt-based)**: `/v1` (TronGrid) = UNTRUSTED DISCOVERY by PRIMARY only; used only to bound which txHashes to inspect. Credit decisions come EXCLUSIVELY from BOTH providers independently parsing on-chain tx receipt event logs via `gettransactioninfobyid` (`src/chain/tron/receiptScan.ts`). Secondary NEVER called for `/v1` paths. Primary and secondary must be independent endpoints. Error from either = skip candidate this tick (no failover). No network-specific relaxations exist (testnet and mainnet use identical logic).
- **Watcher cursor correctness**: `min_timestamp` is only an optimization. Unresolved invoices (`pending`, `payment_detected`, `overdue`) are replay-scanned so provider lag/disagreement cannot permanently hide an older transfer behind the advanced global cursor.
- **Login rate-limit (AUTH-1)**: `POST /v1/auth/login` is rate-limited per-IP (keyed on `req.socket.remoteAddress`) before any Argon2 or DB work; returns 429 on excess attempts.
- **Login timing equalization (AUTH-5)**: on an unknown email the handler runs a dummy `argon2.verify` against a fixed module-level decoy hash (in the same place the real verify would run, after the rate-limit check) so response timing does not reveal whether an operator email exists. The generic `INVALID_CREDENTIALS` response is unchanged.
- **Webhook secret minimum (WH-5)**: `POST /v1/webhooks` rejects a caller-supplied `secret` shorter than 16 chars / empty with `400 INVALID_SECRET` (the `??` fallback only triggered on null/undefined before, so `""` was stored verbatim). When no secret is supplied, the server generates a strong one (`randomBytes(32)`).
- **Login response body (SEC-4)**: `POST /v1/auth/login` returns `{ data: { email } }` only — no `sessionId` in the body. The session is delivered exclusively via an HttpOnly `Set-Cookie` header.
- **Framework error messages (AUTH-4)**: non-500 errors (validation failures, not-found, etc.) return a generic `message`; the typed `code` field is always present. Do not parse `message` — use `code` for programmatic branching.
- **Kill-switch**: `isPaused("invoices" | "watcher" | "webhooks")` — env flags `STABLERAILS_PAUSE_*=1` are **boot-time only** (require restart). Runtime control (no restart): `POST /v1/admin/killswitch { area, paused }` / `GET /v1/admin/killswitch` (admin scope) — DB-backed (`KillSwitch` table), works cross-process (watcher + webhook drain pick up within ~1.5s). In-memory `pauseArea()` / `resumeArea()` remain for tests/direct code use.
- **API-key scopes** (capability hierarchy): `readonly < merchant < admin`. `readonly` grants agent-facing GET endpoints and `POST /v1/sweeps/prepare` (prepare unsigned sweep intents only); broadcast-result and admin mutations remain admin-only. The MCP server should run with a `readonly` key via **`STABLERAILS_MCP_KEY`** (falls back to `STABLERAILS_ADMIN_KEY` if unset).
- **Event-scoped keys**: API keys may carry `eventId`; scoped keys can only create/list/read/cancel invoices for that event. Unscoped keys keep single-tenant/global behavior for backwards compatibility.
- **Multi-merchant tenancy (TENANT-1)**: `ApiKey.merchantId` + `Event.merchantId` (nullable). Invoices/sweep intents inherit tenancy through their event. `admin` keys see everything (merchantId ignored, cannot be minted with one). `merchant`/`readonly` keys see ONLY their tenant; a key with `merchantId = null` is a legacy single-tenant key scoped to null-tenant resources only. Cross-tenant by-id access returns **404 identical to not-found** (no existence leak); `POST /v1/sweeps/prepare` (readonly+) is tenant-scoped the same way — a key may only prepare sweeps for events in its own tenant. `POST /v1/events` is merchant+ (a merchant creates events in its own tenant; admin may pass explicit `merchantId`). Enforced in `src/server/auth.ts` (`tenantOf`/`matchesTenant`) + routes; tests in `src/server/__tests__/tenant-isolation.test.ts`.
- **Webhook secret encryption at rest (WH-6)**: when `STABLERAILS_DATA_KEY` (64-hex, 32 bytes) is set, webhook HMAC secrets are stored AES-256-GCM-encrypted (`enc:v1:<iv>:<ct>:<tag>` in the existing `secret` column — `src/lib/secretBox.ts`); decryption happens at point of use in delivery. Unset key = plaintext (legacy, warned once). Plaintext legacy rows keep working (lazy migration); decrypt failure fails closed (delivery retries, never signs with ciphertext). No API response returns a stored secret (one-time reveal at POST create only).
- **Invoice TTL cap (SEC-2)**: `ttlMinutes` max is **1440** (24 h); non-integer, NaN, or out-of-range values → `400 TTL_OUT_OF_RANGE`. `expiresInSeconds` is capped at `1440 * 60`; idempotency cache retention is also capped at 24 h.
- **Invoice idempotency**: production persists `POST /v1/invoices` idempotency rows in DB (`InvoiceIdempotency`) scoped by API key. Rows reserve `processing` before invoice creation and finish as `completed`; same key/body replays cached responses, same key/different body returns `409`, and an in-flight duplicate waits briefly before `425 IDEMPOTENCY_IN_PROGRESS`.
- **Security headers (SEC-3)**: `@fastify/helmet` runs on every route. HTML routes (`/login`, `/api-keys`, `/pay/:id`) use a nonce-based CSP with `script-src` locked to the per-request nonce. JSON API routes have CSP disabled (no HTML served).
- **SSRF / DNS pinning (WH-1)**: `ssrfGuardedFetch` resolves the hostname once, validates all IPs, then builds an `undici.Agent` whose `connect.lookup` callback returns the pre-validated IP — so a TTL=0 rebinding attack cannot redirect the connection. Fail-closed: missing `undici` throws at startup.
- **Webhook URL pre-screen (WH-4)**: `POST /v1/webhooks` validates `url` at registration time — must be `https://` and must pass the SSRF guard (private/loopback/link-local/metadata IPs rejected). Failures return `400 INVALID_URL`. Delivery never reaches a URL that failed registration validation.
- **Webhook delivery claims**: production `claimPending` uses a DB claim lease with `SELECT ... FOR UPDATE SKIP LOCKED`; workers do not hold locks during HTTP and stale claim tokens are rejected on mark* updates.
- **Webhook test sends**: `POST /v1/webhooks/test` performs a signed SSRF-guarded POST and returns `delivered: true` only for 2xx; inactive endpoints return `409 WEBHOOK_INACTIVE`; secrets are never returned.

## Commands

```bash
npm run dev          # Dev server (tsx watch — Fastify)
npm run worker       # Block watcher + webhook delivery worker
npm run build        # prisma generate + tsc
npm run lint         # ESLint (must be 0 errors)
npm run typecheck    # tsc --noEmit
npm test             # Vitest (offline, ~1028 tests)
npm run audit:ci     # npm audit gate with reviewed-advisory allowlist
npm run cli:mcp      # Start MCP server on stdio (dev)
```

## Known Limitations / Go-Live Steps

- **No live broadcast** without `TRON_RPC_PRIMARY_URL` (or legacy `TRON_RPC_PRIMARY`) set — sign-only dry-run works offline
- **`STABLERAILS_MAIN_WALLET` required for `sweep execute`** — set to the main wallet `T...` Base58 address (SIGN-2); unset or invalid = refusal to run
- **Live broadcast gated by SIGN-3**: when the live RPC env is set, `sweep execute` derives real signable txs via `src/chain/tron/broadcast.ts#triggerSmartContract` + `verifyNodeTransaction`; mock txs are still refused on the live path
- **Real seed + Hetzner deploy** are human-operator steps; do not automate passphrase
- **MCP binary** requires `npm run build` + compiled output for production (`npm run cli:mcp` for dev)
- **npm audit gate**: `npm run audit:ci` (config `audit-ci.jsonc`) — fails on any non-allowlisted advisory at `low`+. Allowlisted: `GHSA-848j-6mx2-7j84` (elliptic via tronweb, signer-path only, reviewed; tracked for tronweb upgrade)
- **Watch-only container env hygiene (DEPLOY-1)**: `docker-compose.yml` injects only the minimal env each service needs via explicit `environment:` (no blanket `env_file: .env`). The encrypted seed (`STABLERAILS_ENCRYPTED_SEED`) and `STABLERAILS_MAIN_WALLET` MUST NOT be placed in the `server`/`worker` env — they belong on the operator's machine only (`.env.docker.example` separates "server/worker vars" from "operator-only / signer vars"). The runtime Docker image runs as non-root `USER node` with no build toolchain (compiler/argon2 build stay in the builder stage).
- **Dev bootstrap script (DEPLOY-2)**: `scripts/bootstrap-operator.ts` is **dev-only** — it hard-refuses to run when `NODE_ENV=production` and reads the password from `BOOTSTRAP_OPERATOR_PASSWORD` (no hardcoded default). The production operator-provisioning path is the TTY-gated `src/cli/commands/operator.ts`.
- **Seed KDF (SIGN-4)**: seed blobs are version-aware. v2 (current) derives the AES key via **native `argon2`** (argon2id, `m=65536` 64 MiB, `t=3`, raw output; async on the libuv threadpool — does not block the event loop). v1 legacy blobs (`@noble` pure-JS, `m=19456,t=2`) still decrypt. KDF params are selected from a trusted code-defined version map — `blob.params` is informational only and NEVER trusted (anti-downgrade). `encryptSeed`/`decryptSeed` are async.
- **Orphan revival (WATCH-2)**: a payment orphaned by a pre-solid reorg is revived to `detected` when the same `(network, txHash, logIndex)` is re-observed with two-provider agreement and a real block placement; it then flows through the normal detected→confirmed solid gate (never jumps to confirmed/paid). `amountUsdt` stays immutable.

<!-- updated-by-superflow:2026-06-06 -->
