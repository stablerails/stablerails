/**
 * AI-agent onboarding routes.
 *
 * GET /llms.txt  — text/plain llms-standard summary: what Stablerails is, key
 *                  URLs, the init command, and the security contract one-liner.
 * GET /agents.md — text/markdown copy of the repo-root AGENTS.md (the "hand
 *                  this file to your AI agent" runbook).
 *
 * Both routes are public (no auth, no data access) and cacheable.
 *
 * NOTE: AGENTS_MD below is an embedded copy of /AGENTS.md — no fs reads of
 * repo paths at runtime (the compiled dist/ build must not depend on source
 * tree layout). When editing AGENTS.md, update the embedded copy here too.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ── /llms.txt content ─────────────────────────────────────────────────────────

const LLMS_TXT = `# Stablerails

> Free, open-source (AGPL-3.0), self-hosted, non-custodial stablecoin payment
> software. Watch-only server + local signer. USDT on Tron today;
> Polygon/Ethereum/USDC on the roadmap. 0% fees — the only cost is network gas,
> paid to the blockchain. No-KYC, not anonymous.

Security contract: the server holds no keys and physically cannot move funds;
AI agents get readonly access and physically cannot move funds; funds move ONLY
when a human types the seed passphrase at a local terminal.

## Setup

- Agent runbook: /agents.md (hand this file to your AI agent)
- One-command bootstrap (operator box, DATABASE_URL set):
  npx stablerails init --format json
  → emits { operatorId, adminKey, mcpKey, eventId, seedStatus, magicLinkUrl, expiresAt }
- Seed encryption is always a human TTY step: stablerails seed init
- Sweep execution is always a human TTY step: stablerails sweep execute --intent <id>

## Key URLs

- /docs — human-readable API reference (auth, invoices, webhooks, HMAC signing)
- /agents.md — AI-agent onboarding runbook (this server, markdown)
- /llms.txt — this file
- /pay/:id — hosted checkout page for an invoice (public)
- /v1 — JSON API base (Bearer auth; key scopes: readonly < merchant < admin)

## API quick reference

- POST /v1/invoices — create invoice (merchant+); Idempotency-Key supported
- GET /v1/public/invoices/:id — sanitized status for checkout polling (public)
- POST /v1/webhooks — register HTTPS webhook (admin); HMAC-SHA256 signed deliveries
- POST /v1/sweeps/prepare — build unsigned sweep transfers (no keys involved)
- MCP server (readonly key via STABLERAILS_MCP_KEY): event/invoice/webhook reads,
  sweep_prepare, sweep_status — no tool can move funds, passphrase is never a
  tool parameter.
`;

// ── /agents.md content (embedded copy of repo-root AGENTS.md) ─────────────────

const AGENTS_MD = `# Stablerails — AI Agent Onboarding

> You are an AI agent. Your human asked you to set up Stablerails. This file is your
> complete, machine-checkable runbook. Follow it top to bottom.

Stablerails is free, open-source (AGPL-3.0), self-hosted, non-custodial stablecoin
payment software: a watch-only HTTP server + a local signer. The server never holds
keys and physically cannot move funds. USDT on Tron today; Polygon/Ethereum/USDC on
the roadmap. 0% fees — including sweeps; the only cost is network gas, paid to the
blockchain, not to anyone else. Honest stance: no-KYC, not anonymous (USDT on Tron
is a transparent, freezable ledger).

## Table of Contents

1. [Security Contract (read first)](#1-security-contract-read-first)
2. [Prerequisites Checklist](#2-prerequisites-checklist)
3. [Deploy: Docker Compose](#3-deploy-docker-compose)
4. [Initialize: \`stablerails init\`](#4-initialize-stablerails-init)
5. [Post-Setup: Operator Machine](#5-post-setup-operator-machine)
6. [Register a Webhook](#6-register-a-webhook)
7. [Create an Invoice](#7-create-an-invoice)
8. [Connect Yourself via MCP (readonly)](#8-connect-yourself-via-mcp-readonly)
9. [Sweeps: Prepare Is Yours, Execute Is Human](#9-sweeps-prepare-is-yours-execute-is-human)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Security Contract (read first)

These are HARD RULES. They are enforced by the software (TTY checks, key scopes,
server↛signer boundary), but you must also respect them in your behavior:

- **You MUST hand control back to the human for exactly two things:**
  - **(a) Seed passphrase entry** — \`stablerails seed init\` reads the mnemonic and
    passphrase via hidden TTY input only. It rejects piped/non-interactive stdin.
  - **(b) Sweep execution** — \`stablerails sweep execute\` moves funds and prompts
    for the passphrase at the terminal. Only a human can complete it.
- **NEVER** ask for, accept, store, log, or transmit a mnemonic or passphrase.
  They are never CLI flags, env vars, API fields, or MCP tool parameters.
- The seed never touches the server — for ANY chain. The deployed containers are
  watch-only and receive no key material.
- You MAY do everything else: install, configure, deploy, run \`stablerails init\`,
  create invoices, register webhooks, prepare sweeps, and read all data with a
  \`readonly\` key. A readonly key physically cannot move funds or write anything.

If a step below says **HUMAN STEP**, stop, tell the human exactly what to run,
and wait for them to confirm completion.

## 2. Prerequisites Checklist

Verify each item before starting. Ask the human for anything missing:

- [ ] A VPS or local box with **Docker + docker compose** installed
      (\`docker compose version\` succeeds).
- [ ] **PostgreSQL** — the bundled compose file ships one; an external Postgres
      works too (set \`DATABASE_URL\`).
- [ ] **Node.js 22+** on the operator's machine (\`node --version\` → \`v22\` or later)
      — needed for the CLI (\`stablerails init\`, seed and sweep commands).
- [ ] **Two independent Tron RPC endpoints** on the same network. A free TronGrid
      API key (https://www.trongrid.io) plus one other provider/public node is
      enough. The two URLs MUST differ — the worker refuses identical endpoints.
- [ ] **The operator's main wallet address** — a Tron Base58 address (\`T...\`),
      e.g. their Ledger account. This is where sweeps send funds. The agent never
      needs its private key.

## 3. Deploy: Docker Compose

\`\`\`bash
git clone https://github.com/<your-org>/stablerails.git
cd stablerails
cp .env.docker.example .env
\`\`\`

Edit \`.env\` (\`STABLERAILS_*\` app vars, \`TRON_*\` chain vars):

| Variable | Required | Value |
|---|---|---|
| \`DATABASE_URL\` | yes (external PG only) | bundled compose wires its own Postgres automatically |
| \`TRON_RPC_PRIMARY_URL\` | yes | e.g. \`https://api.trongrid.io\` |
| \`TRON_RPC_PRIMARY_API_KEY\` | recommended | TronGrid API key (free tier is fine) |
| \`TRON_RPC_SECONDARY_URL\` | yes | a DIFFERENT provider, same network |
| \`TRON_RPC_SECONDARY_API_KEY\` | optional | secondary provider key |
| \`TRON_USDT_CONTRACT\` | optional | leave empty for mainnet USDT; set only for testnets (Nile) |
| \`STABLERAILS_DATA_KEY\` | recommended | \`openssl rand -hex 32\` — encrypts webhook secrets at rest |
| \`PUBLIC_BASE_URL\` | yes | public URL of the server, e.g. \`https://pay.example.com\` |

Do NOT put \`STABLERAILS_ADMIN_KEY\`, \`STABLERAILS_ENCRYPTED_SEED\`, or \`STABLERAILS_MAIN_WALLET\`
into the deployed stack — those live only on the operator's machine. The compose file
deliberately passes an explicit allowlist of variables to each container.

Start and verify:

\`\`\`bash
docker compose up -d
docker compose ps            # server + worker + postgres all running/healthy
curl -fsS http://localhost:3000/llms.txt | head -5
\`\`\`

## 4. Initialize: \`stablerails init\`

Run on the operator's box (where \`DATABASE_URL\` can reach Postgres):

\`\`\`bash
npx stablerails init --format json --public-url https://pay.example.com
# optional: --event "My Store" to create the first payment event in the same run
\`\`\`

Parse the JSON output:

\`\`\`json
{
  "operatorId": "...",
  "adminKey": "...",
  "mcpKey": "...",
  "eventId": null,
  "seedStatus": "ready | needs_human",
  "magicLinkUrl": "https://pay.example.com/auth/magic?token=...",
  "expiresAt": "..."
}
\`\`\`

Then:

1. **Store \`adminKey\` and \`mcpKey\` safely** (the human's secret manager / \`.env\`
   on the operator machine — never in the repo, never in chat logs you persist).
   \`adminKey\` = full control; \`mcpKey\` = readonly, for you.
2. **Deliver \`magicLinkUrl\` to the human** — it logs them into the dashboard
   (route: \`GET /auth/magic?token=...\`). It expires at \`expiresAt\`; mint a fresh
   one any time with \`stablerails operator login-link\`.
3. **If \`seedStatus\` is \`"needs_human"\`** — HUMAN STEP. Tell the human to run:

   \`\`\`bash
   stablerails seed init
   \`\`\`

   They will type (or generate) a BIP39 mnemonic and a passphrase at the terminal.
   You cannot and must not do this for them. When they confirm, run
   \`stablerails init --format json\` again — it is idempotent and will report
   \`seedStatus: "ready"\`.

## 5. Post-Setup: Operator Machine

On the operator's machine only (never in the deployed containers):

\`\`\`bash
export STABLERAILS_API_URL="https://pay.example.com"
export STABLERAILS_ADMIN_KEY="<adminKey from init>"
export STABLERAILS_MAIN_WALLET="T..."        # sweep destination pin — the human's wallet
export STABLERAILS_SEED_FILE="/secure/path/seed.json"   # written by \`seed init\`
\`\`\`

\`STABLERAILS_MAIN_WALLET\` is a hard safety pin: every sweep transfer destination is
asserted against it locally before signing; any mismatch aborts the whole sweep.

## 6. Register a Webhook

The URL must be \`https://\` and publicly reachable (private/loopback IPs are
rejected at registration). Use a secret of at least 16 characters:

\`\`\`bash
curl -fsS -X POST "$STABLERAILS_API_URL/v1/webhooks" \\
  -H "Authorization: Bearer $STABLERAILS_ADMIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://merchant.example.com/hooks/stablerails",
    "secret": "'"$(openssl rand -hex 16)"'"
  }'
\`\`\`

The secret is returned only once — store it on the receiving side and verify the
\`X-Stablerails-Signature: t=<unix>,v1=<hex-hmac-sha256>\` header on every delivery
(signed payload = \`<t>.<rawBody>\`, tolerance 300 s). Full verification snippet:
\`GET /docs\` on your deployment.

Test it: \`curl -X POST "$STABLERAILS_API_URL/v1/webhooks/test" -H "Authorization: Bearer $STABLERAILS_ADMIN_KEY" -H "Content-Type: application/json" -d '{"endpointId":"<id>"}'\`

## 7. Create an Invoice

Requires an event (\`--event\` at init time, or \`stablerails event create\` — note:
event creation derives an xpub and is a seed operation that prompts the human).
Amounts are micro-USDT precision decimal strings; minimum 0.01 USDT; \`ttlMinutes\`
max 1440:

\`\`\`bash
curl -fsS -X POST "$STABLERAILS_API_URL/v1/invoices" \\
  -H "Authorization: Bearer $STABLERAILS_ADMIN_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "eventId": "<eventId from init>",
    "priceFiat": "50.00",
    "fiatCurrency": "USD",
    "ttlMinutes": 60,
    "metadata": { "orderId": "ORD-1001" }
  }'
\`\`\`

Response \`201\` → \`data.id\`, \`data.depositAddress\` (unique per invoice),
\`data.amountUsdt\`, \`data.hostedUrl\` (send the customer to \`/pay/<id>\`). An invoice
becomes \`paid\` only when two independent RPC providers agree the payment is in a
finalized (solid) block — never 0-conf.

## 8. Connect Yourself via MCP (readonly)

The MCP server exposes read/prepare tools only: \`event_list\`, \`event_show\`,
\`invoice_list\`, \`invoice_show\`, \`invoice_find\`, \`webhook_list\`, \`apikey_list\`,
\`sweep_prepare\`, \`sweep_status\`, \`sweep_execute_instructions\`. There is no tool
that can move funds, and the passphrase is never a tool parameter.

\`\`\`json
{
  "mcpServers": {
    "stablerails": {
      "command": "stablerails-mcp",
      "env": {
        "STABLERAILS_API_URL": "https://pay.example.com",
        "STABLERAILS_MCP_KEY": "<mcpKey from init>"
      }
    }
  }
}
\`\`\`

Use the \`readonly\` \`mcpKey\`, not the admin key. From a source checkout:
\`npm run build\` first (the binary is \`dist/mcp/bin.js\`), or \`npm run cli:mcp\` in dev.

## 9. Sweeps: Prepare Is Yours, Execute Is Human

- **Prepare (agent-safe):** builds unsigned transfers from paid deposit addresses
  to the pinned main wallet. Via MCP tool \`sweep_prepare\`, via API
  \`POST /v1/sweeps/prepare\`, or via CLI \`stablerails sweep prepare --event <id>\`.
  No keys involved. Returns a \`SweepIntent\` id.
- **Status (agent-safe):** MCP \`sweep_status\` or \`stablerails sweep status <id>\`.
- **Execute — HUMAN STEP, always:**

  \`\`\`bash
  stablerails sweep execute --intent <intentId>
  \`\`\`

  The human runs this at their local terminal. It prompts for the seed passphrase
  (hidden input; optional Touch ID on macOS via \`stablerails seed keychain enable\`),
  verifies every destination equals \`STABLERAILS_MAIN_WALLET\`, signs locally, and
  broadcasts only if \`TRON_RPC_PRIMARY_URL\` is configured (otherwise dry-run).
  Your job: hand the human the exact command with the intent id, then verify the
  result afterwards with \`sweep_status\`.

## 10. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Server unhealthy / API 500s on boot | Postgres down or unreachable | \`docker compose logs postgres\`; \`docker compose exec postgres pg_isready -U stablerails\`; check \`DATABASE_URL\` |
| Worker exits immediately at startup | RPC endpoints missing or identical | Set \`TRON_RPC_PRIMARY_URL\` and \`TRON_RPC_SECONDARY_URL\` to two DIFFERENT providers on the SAME network (never mix mainnet and Nile) |
| Payments stuck in \`payment_detected\` | The two RPC providers disagree, or block not yet solid | Normal for ~1 min after payment; if persistent, check worker logs and confirm both endpoints are healthy and on the same network |
| \`400 AMOUNT_TOO_SMALL\` on invoice create | Amount below 0.01 USDT | Raise the amount |
| \`400 TTL_OUT_OF_RANGE\` | \`ttlMinutes\` not an integer in 1–1440 | Fix the TTL |
| \`403\` on a write call | Key scope too low (\`readonly < merchant < admin\`) | Use the admin key for writes; keep the readonly key for yourself |
| Invoice creation / watcher / webhooks paused | Kill-switch engaged | \`GET /v1/admin/killswitch\` (admin key) to inspect; \`POST /v1/admin/killswitch {"area":"invoices","paused":false}\` to resume; \`STABLERAILS_PAUSE_*\` env flags are boot-time only and require a restart |
| Where are the logs? | — | \`docker compose logs -f server\` and \`docker compose logs -f worker\` (JSON to stdout); operator CLI prints to stderr |

---

More: human-readable API reference at \`GET /docs\` on your deployment;
machine-readable summary at \`GET /llms.txt\`; this file is served at \`GET /agents.md\`.
`;

// ── Route registration ─────────────────────────────────────────────────────────

export function registerLlmsRoutes(app: FastifyInstance): void {
  app.get("/llms.txt", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(200)
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .send(LLMS_TXT);
  });

  app.get("/agents.md", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(200)
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .send(AGENTS_MD);
  });
}
