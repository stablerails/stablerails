#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Stablerails dev-bootstrap.sh
#
# Bootstraps a working merchant flow for local Docker-based development.
# MUST run from the repo root with the server already up (docker compose up -d).
#
# Steps performed:
#   1. operator init  — create the first operator (requires TTY for password)
#   2. seed init      — encrypt a dev-only throwaway mnemonic (requires TTY)
#   3. login          — obtain a session cookie
#   4. mint admin key — POST /v1/api-keys (admin)
#   5. event create   — derive xpub from seed and POST /v1/events (requires TTY)
#   6. mint merchant key — POST /v1/api-keys (merchant)
#   7. mint readonly key — POST /v1/api-keys (readonly)
#   8. write .dev-state  — capture ids/keys for demo page and scripts
#   9. patch .env        — enable local demo and write DEMO_MERCHANT_KEY + DEMO_EVENT_ID
#
# Requirements:
#   - Docker Compose stack running (docker compose up -d)
#   - Node >=22 + npx available locally
#   - jq installed (brew install jq)
#   - The server health check passed (server is accepting requests)
#
# Usage:
#   cd /path/to/stablerails
#   bash scripts/dev-bootstrap.sh
#
# Re-running: safe — duplicate operator init exits gracefully (P2002); duplicate
# event create will use account 0 again (change --account if needed).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${STABLERAILS_API_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.dev}"
STATE_FILE="${REPO_ROOT}/.dev-state"
SEED_FILE="${REPO_ROOT}/.dev-seed.json"

# ── Dependency check ──────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi
if ! command -v npx &>/dev/null; then
  echo "ERROR: npx (Node.js) is required." >&2
  exit 1
fi

# ── Wait for server ───────────────────────────────────────────────────────────
echo ""
echo "=== Stablerails dev-bootstrap ==="
echo ""
echo "Waiting for server at $API_URL ..."
for i in $(seq 1 30); do
  if curl -sf "${API_URL}/v1/public/invoices/healthz" &>/dev/null 2>&1 \
     || curl -sf "${API_URL}" &>/dev/null 2>&1; then
    echo "Server is up."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: server not reachable at $API_URL after 30s. Run: docker compose up -d" >&2
    exit 1
  fi
  sleep 1
done

# ── Step 1: operator init ─────────────────────────────────────────────────────
echo ""
echo "── Step 1: operator init ──────────────────────────────────────────────"
echo "Creating operator account for: $ADMIN_EMAIL"
echo "(You will be prompted for a password. Use any strong password for dev.)"
echo ""
DATABASE_URL="postgresql://stablerails:stablerails_dev@localhost:5432/stablerails" \
  npx tsx "${REPO_ROOT}/src/cli/index.ts" operator init \
    --email "$ADMIN_EMAIL" \
  || echo "Operator may already exist — continuing."

# ── Step 2: seed init ─────────────────────────────────────────────────────────
echo ""
echo "── Step 2: seed init ──────────────────────────────────────────────────"
echo "STABLERAILS_SEED_FILE=${SEED_FILE}"
echo ""
echo "This generates a THROWAWAY dev mnemonic. Press Enter when prompted for"
echo "the mnemonic to auto-generate one. Choose a dev passphrase (e.g. 'devpass')."
echo ""
STABLERAILS_SEED_FILE="${SEED_FILE}" \
  npx tsx "${REPO_ROOT}/src/cli/index.ts" seed init

# ── Step 3: login and get session cookie ─────────────────────────────────────
echo ""
echo "── Step 3: login ──────────────────────────────────────────────────────"
echo "Enter the operator password you just created:"
read -rs ADMIN_PASSWORD
echo ""

LOGIN_RESP=$(curl -sf -c /tmp/stablerails-session.txt \
  -X POST "${API_URL}/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
  -w "\n%{http_code}")

LOGIN_CODE=$(echo "$LOGIN_RESP" | tail -1)
if [ "$LOGIN_CODE" != "200" ]; then
  echo "ERROR: Login failed (HTTP $LOGIN_CODE). Check email/password." >&2
  exit 1
fi
echo "Login successful."

# ── Step 4: mint admin key ────────────────────────────────────────────────────
echo ""
echo "── Step 4: mint admin key ─────────────────────────────────────────────"
ADMIN_KEY_RESP=$(curl -sf \
  -X POST "${API_URL}/v1/api-keys" \
  -H "Content-Type: application/json" \
  -b /tmp/stablerails-session.txt \
  -d '{"label":"dev-admin","scope":"admin"}')

ADMIN_KEY=$(echo "$ADMIN_KEY_RESP" | jq -r '.data.rawKey // empty')
if [ -z "$ADMIN_KEY" ]; then
  echo "ERROR: Failed to mint admin key." >&2
  echo "$ADMIN_KEY_RESP" >&2
  exit 1
fi
echo "Admin key minted: ${ADMIN_KEY:0:16}..."

# ── Step 5: event create (requires seed + passphrase) ─────────────────────────
echo ""
echo "── Step 5: event create ───────────────────────────────────────────────"
echo "Creating event 'Dev Event' with account 0."
echo "Enter the seed passphrase you chose in Step 2:"
echo ""
# Use a placeholder Tron address as main-wallet — go-live step is a real T... address.
DEV_MAIN_WALLET="TRX1111111111111111111111111111111"
STABLERAILS_SEED_FILE="${SEED_FILE}" \
  STABLERAILS_ADMIN_KEY="${ADMIN_KEY}" \
  STABLERAILS_API_URL="${API_URL}" \
  npx tsx "${REPO_ROOT}/src/cli/index.ts" event create \
    --name "Dev Event" \
    --main-wallet "${DEV_MAIN_WALLET}" \
    --account 0 \
  > /tmp/stablerails-event.json

EVENT_ID=$(cat /tmp/stablerails-event.json | jq -r '.id // empty')
if [ -z "$EVENT_ID" ]; then
  echo "ERROR: event create failed. Response:" >&2
  cat /tmp/stablerails-event.json >&2
  exit 1
fi
echo "Event created: $EVENT_ID"

# ── Step 6: mint merchant key ─────────────────────────────────────────────────
echo ""
echo "── Step 6: mint merchant key ──────────────────────────────────────────"
MERCHANT_KEY_RESP=$(curl -sf \
  -X POST "${API_URL}/v1/api-keys" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ADMIN_KEY}" \
  -d '{"label":"dev-merchant","scope":"merchant"}')

MERCHANT_KEY=$(echo "$MERCHANT_KEY_RESP" | jq -r '.data.rawKey // empty')
if [ -z "$MERCHANT_KEY" ]; then
  echo "ERROR: Failed to mint merchant key." >&2
  echo "$MERCHANT_KEY_RESP" >&2
  exit 1
fi
echo "Merchant key minted: ${MERCHANT_KEY:0:16}..."

# ── Step 7: mint readonly key ─────────────────────────────────────────────────
echo ""
echo "── Step 7: mint readonly key ──────────────────────────────────────────"
READONLY_KEY_RESP=$(curl -sf \
  -X POST "${API_URL}/v1/api-keys" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ADMIN_KEY}" \
  -d '{"label":"dev-readonly","scope":"readonly"}')

READONLY_KEY=$(echo "$READONLY_KEY_RESP" | jq -r '.data.rawKey // empty')
if [ -z "$READONLY_KEY" ]; then
  echo "ERROR: Failed to mint readonly key." >&2
  echo "$READONLY_KEY_RESP" >&2
  exit 1
fi
echo "Readonly key minted: ${READONLY_KEY:0:16}..."

# ── Step 8: write .dev-state ──────────────────────────────────────────────────
echo ""
echo "── Step 8: writing .dev-state ─────────────────────────────────────────"
cat > "${STATE_FILE}" <<EOF
# Stablerails local dev state
# Generated by dev-bootstrap.sh — not committed (gitignored)
ADMIN_EMAIL="${ADMIN_EMAIL}"
ADMIN_KEY="${ADMIN_KEY}"
MERCHANT_KEY="${MERCHANT_KEY}"
READONLY_KEY="${READONLY_KEY}"
EVENT_ID="${EVENT_ID}"
SEED_FILE="${SEED_FILE}"
API_URL="${API_URL}"
EOF
chmod 600 "${STATE_FILE}"
echo "Written to: ${STATE_FILE}"

# ── Step 9: patch .env ────────────────────────────────────────────────────────
echo ""
echo "── Step 9: patching .env with DEMO_MERCHANT_KEY + DEMO_EVENT_ID ───────"
ENV_FILE="${REPO_ROOT}/.env"

# Update or append DEMO_MERCHANT_KEY
if grep -q "^DEMO_MERCHANT_KEY=" "${ENV_FILE}" 2>/dev/null; then
  # Use perl for portable in-place replacement (sed -i differs macOS/Linux)
  perl -pi -e "s|^DEMO_MERCHANT_KEY=.*|DEMO_MERCHANT_KEY=\"${MERCHANT_KEY}\"|" "${ENV_FILE}"
else
  echo "DEMO_MERCHANT_KEY=\"${MERCHANT_KEY}\"" >> "${ENV_FILE}"
fi

# Update or append DEMO_EVENT_ID
if grep -q "^DEMO_EVENT_ID=" "${ENV_FILE}" 2>/dev/null; then
  perl -pi -e "s|^DEMO_EVENT_ID=.*|DEMO_EVENT_ID=\"${EVENT_ID}\"|" "${ENV_FILE}"
else
  echo "DEMO_EVENT_ID=\"${EVENT_ID}\"" >> "${ENV_FILE}"
fi

echo "Updated .env"

# Enable the demo for local Docker development. The app still refuses to mount
# demo routes when STABLERAILS_ENV/NODE_ENV is production.
if grep -q "^ENABLE_DEMO=" "${ENV_FILE}" 2>/dev/null; then
  perl -pi -e 's|^ENABLE_DEMO=.*|ENABLE_DEMO="1"|' "${ENV_FILE}"
else
  echo 'ENABLE_DEMO="1"' >> "${ENV_FILE}"
fi

if grep -q "^STABLERAILS_ENV=" "${ENV_FILE}" 2>/dev/null; then
  perl -pi -e 's|^STABLERAILS_ENV=.*|STABLERAILS_ENV="development"|' "${ENV_FILE}"
else
  echo 'STABLERAILS_ENV="development"' >> "${ENV_FILE}"
fi

echo "Enabled local-only demo mode in .env"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " Bootstrap complete!"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo " Event ID:     ${EVENT_ID}"
echo " Admin key:    ${ADMIN_KEY:0:16}...  (see .dev-state)"
echo " Merchant key: ${MERCHANT_KEY:0:16}...  (see .dev-state)"
echo " Readonly key: ${READONLY_KEY:0:16}...  (see .dev-state)"
echo " Seed file:    ${SEED_FILE}"
echo ""
echo " Next steps:"
echo "   1. Restart the server to pick up updated .env:"
echo "      docker compose restart server"
echo "   2. Open the demo page: ${API_URL}/demo"
echo "   3. Place a test order and watch the checkout page."
echo "   4. Check invoice status: ${API_URL}/v1/public/invoices/<id>"
echo ""
echo " NOTE: Real payment credit requires Tron testnet (Nile) — out of scope here."
echo "       See the testnet-feasibility section in the report."
echo ""
