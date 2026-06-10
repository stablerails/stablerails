#!/usr/bin/env bash
# deploy-hetzner.sh — Stablerails one-box Hetzner deployment helper
#
# Subcommands:
#   provision   — Create CX22, firewall, print IP (idempotent: skips if server exists)
#   dns         — Point pay.example.com A record at <ip> via godaddy-dns
#   deploy      — Rsync repo to box + write .env + docker compose up (also used for updates)
#   backup      — Run pg-backup.sh on the remote box immediately
#
# USAGE:
#   ./scripts/deploy-hetzner.sh provision
#   ./scripts/deploy-hetzner.sh dns <ip>
#   ./scripts/deploy-hetzner.sh deploy <ip>
#   ./scripts/deploy-hetzner.sh backup <ip>
#
# REQUIRED ENV:
#   HCLOUD_TOKEN          — Hetzner Cloud API token
#   SSH_KEY_NAME          — Name of SSH key already uploaded to Hetzner (default: claude-code)
#
# For the deploy subcommand additionally:
#   POSTGRES_PASSWORD     — Strong random password for Postgres
#   TRON_RPC_PRIMARY_URL  — Primary Tron mainnet full-node URL
#   TRON_RPC_SECONDARY_URL— Secondary Tron mainnet full-node URL (must differ from primary)
#   TRON_RPC_PRIMARY_API_KEY — (optional) API key for primary node
#   TRON_RPC_SECONDARY_API_KEY — (optional) API key for secondary node
#   PUBLIC_BASE_URL       — e.g. https://pay.example.com
#   DOMAIN                — e.g. pay.example.com (default: pay.example.com)
#   STABLERAILS_ADMIN_KEY    — Admin bearer key (set after first bootstrap; empty on first deploy)
#
# Nothing runs without an explicit subcommand. Safe to source/inspect.

set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
SERVER_NAME="stablerails-prod"
SERVER_TYPE="${SERVER_TYPE:-cpx22}"   # AMD 2 vCPU / 4 GB / 80 GB (cx22 was renamed; cpx22 is broadly available)
SERVER_IMAGE="ubuntu-24.04"
SERVER_LOCATION="${SERVER_LOCATION:-fsn1}"   # Frankfurt; override via env (e.g. hel1, nbg1, ash)
FIREWALL_NAME="stablerails-fw"
SSH_KEY_NAME="${SSH_KEY_NAME:-claude-code}"
DEPLOY_USER="root"
REMOTE_DIR="/opt/stablerails"
DOMAIN="${DOMAIN:-pay.example.com}"
GODADDY_DNS="${GODADDY_DNS:-godaddy-dns}"   # path to godaddy-dns binary (must be in PATH or absolute)

# Colours for clarity
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()   { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────────────

require_env() {
    local var="$1"
    [[ -n "${!var:-}" ]] || die "Required env var \$$var is not set."
}

hcloud_server_ip() {
    hcloud server describe "$SERVER_NAME" -o json 2>/dev/null \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['public_net']['ipv4']['ip'])" 2>/dev/null || true
}

wait_for_ssh() {
    local ip="$1"
    info "Waiting for SSH on $ip ..."
    local i=0
    until ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
            "${DEPLOY_USER}@${ip}" "echo ok" &>/dev/null; do
        i=$((i+1))
        [[ $i -lt 30 ]] || die "SSH did not become available after 150 s"
        sleep 5
    done
    info "SSH ready."
}

# ── Subcommand: provision ─────────────────────────────────────────────────────
# Creates firewall + CX22 server. Idempotent — skips creation if already exists.
cmd_provision() {
    require_env HCLOUD_TOKEN

    info "=== PROVISION ==="

    # ── Firewall (idempotent) ──────────────────────────────────────────────────
    if hcloud firewall describe "$FIREWALL_NAME" &>/dev/null; then
        info "Firewall '$FIREWALL_NAME' already exists — skipping."
    else
        info "Creating firewall '$FIREWALL_NAME' (allow 22/tcp, 80/tcp, 443/tcp) ..."
        hcloud firewall create --name "$FIREWALL_NAME"

        # SSH
        hcloud firewall add-rule "$FIREWALL_NAME" \
            --direction in --protocol tcp --port 22 \
            --source-ips "0.0.0.0/0" --source-ips "::/0" \
            --description "SSH"

        # HTTP (needed for ACME HTTP-01 challenge and redirect)
        hcloud firewall add-rule "$FIREWALL_NAME" \
            --direction in --protocol tcp --port 80 \
            --source-ips "0.0.0.0/0" --source-ips "::/0" \
            --description "HTTP"

        # HTTPS
        hcloud firewall add-rule "$FIREWALL_NAME" \
            --direction in --protocol tcp --port 443 \
            --source-ips "0.0.0.0/0" --source-ips "::/0" \
            --description "HTTPS"

        info "Firewall created."
    fi

    # ── Server (idempotent) ────────────────────────────────────────────────────
    local existing_ip
    existing_ip="$(hcloud_server_ip)"

    if [[ -n "$existing_ip" ]]; then
        info "Server '$SERVER_NAME' already exists at $existing_ip — skipping creation."
    else
        info "Creating server '$SERVER_NAME' ($SERVER_TYPE, $SERVER_IMAGE, $SERVER_LOCATION) ..."
        hcloud server create \
            --name "$SERVER_NAME" \
            --type "$SERVER_TYPE" \
            --image "$SERVER_IMAGE" \
            --location "$SERVER_LOCATION" \
            --ssh-key "$SSH_KEY_NAME" \
            --firewall "$FIREWALL_NAME"

        existing_ip="$(hcloud_server_ip)"
        info "Server created."
    fi

    info "=== Server IP: $existing_ip ==="
    echo "$existing_ip"
}

# ── Subcommand: dns ────────────────────────────────────────────────────────────
# Updates the GoDaddy A record for pay.example.com
cmd_dns() {
    local ip="${1:-}"
    [[ -n "$ip" ]] || die "Usage: $0 dns <ip>"

    info "=== DNS ==="
    info "Setting A record: pay.example.com → $ip"

    # godaddy-dns set-a <domain> <subdomain> <ip>
    "${GODADDY_DNS}" set-a example.com pay "$ip"

    info "DNS record updated. Propagation may take 1–5 minutes."
    info "Verify: dig +short pay.example.com @8.8.8.8"
}

# ── Subcommand: deploy ─────────────────────────────────────────────────────────
# Rsync repo → box, write .env, start/update compose stack.
# Also used for rolling updates (git pull + up -d --build on the remote).
cmd_deploy() {
    local ip="${1:-}"
    [[ -n "$ip" ]] || die "Usage: $0 deploy <ip>"

    # Required for a working stack
    require_env POSTGRES_PASSWORD
    require_env TRON_RPC_PRIMARY_URL
    require_env TRON_RPC_SECONDARY_URL
    require_env PUBLIC_BASE_URL

    info "=== DEPLOY → $ip ==="

    wait_for_ssh "$ip"

    # ── Install Docker on the box (idempotent) ────────────────────────────────
    info "Ensuring Docker is installed on remote ..."
    ssh -o StrictHostKeyChecking=no "${DEPLOY_USER}@${ip}" bash <<'REMOTE_INSTALL'
set -euo pipefail
if command -v docker &>/dev/null; then
    echo "[remote] Docker already installed: $(docker --version)"
    exit 0
fi
echo "[remote] Installing Docker ..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
   https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
echo "[remote] Docker installed: $(docker --version)"
REMOTE_INSTALL

    # ── Sync repo ─────────────────────────────────────────────────────────────
    info "Syncing repo to ${DEPLOY_USER}@${ip}:${REMOTE_DIR} ..."
    # Determine repo root (one level up from scripts/)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

    ssh -o StrictHostKeyChecking=no "${DEPLOY_USER}@${ip}" "mkdir -p ${REMOTE_DIR}"

    # SECURITY: ':- .gitignore' makes rsync honor .gitignore, so gitignored
    # local secrets (.env, .testnet-seed.json, .session-state.md, key material)
    # can never reach the box. Explicit excludes kept as belt-and-suspenders
    # for files that are not gitignored but still must not ship (.claude/).
    rsync -az --delete \
        --exclude='.git' \
        --filter=':- .gitignore' \
        --exclude='.claude' \
        --exclude='node_modules' \
        --exclude='dist' \
        --exclude='.env' \
        --exclude='.env.*' \
        --exclude='.dev-state' \
        --exclude='.dev-seed.json' \
        --exclude='.superflow-state.json' \
        --exclude='.worktrees' \
        --exclude='audits' \
        --exclude='coverage' \
        -e "ssh -o StrictHostKeyChecking=no" \
        "${REPO_ROOT}/" \
        "${DEPLOY_USER}@${ip}:${REMOTE_DIR}/"

    info "Repo synced."

    # ── Write .env on the remote ───────────────────────────────────────────────
    info "Writing .env on remote ..."
    # Build the env file content from current shell environment.
    # Only vars used by docker-compose.prod.yml are written.
    # Secrets are passed from the deploying shell — never stored in the repo.
    # NOTE: ENV_WRITE heredoc is intentionally unquoted so the local shell
    # substitutes POSTGRES_PASSWORD, TRON_RPC_* etc. into the remote command.
    # shellcheck disable=SC2087
    ssh -o StrictHostKeyChecking=no "${DEPLOY_USER}@${ip}" bash <<ENV_WRITE
set -euo pipefail
cat > ${REMOTE_DIR}/.env <<'ENVEOF'
# Generated by deploy-hetzner.sh — DO NOT COMMIT
POSTGRES_USER=stablerails
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=stablerails
DATABASE_URL=postgresql://stablerails:${POSTGRES_PASSWORD}@postgres:5432/stablerails
TRON_RPC_PRIMARY_URL=${TRON_RPC_PRIMARY_URL}
TRON_RPC_SECONDARY_URL=${TRON_RPC_SECONDARY_URL}
TRON_RPC_PRIMARY_API_KEY=${TRON_RPC_PRIMARY_API_KEY:-}
TRON_RPC_SECONDARY_API_KEY=${TRON_RPC_SECONDARY_API_KEY:-}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
DOMAIN=${DOMAIN}
STABLERAILS_ADMIN_KEY=${STABLERAILS_ADMIN_KEY:-}
LOG_LEVEL=${LOG_LEVEL:-info}
LATE_FUNDS_GRACE_DAYS=${LATE_FUNDS_GRACE_DAYS:-7}
TRON_USDT_CONTRACT=${TRON_USDT_CONTRACT:-}
WATCHER_TESTNET_SINGLE_TRANSFER_PROVIDER=${WATCHER_TESTNET_SINGLE_TRANSFER_PROVIDER:-}
ENABLE_DEMO=${ENABLE_DEMO:-}
DEMO_MERCHANT_KEY=${DEMO_MERCHANT_KEY:-}
DEMO_EVENT_ID=${DEMO_EVENT_ID:-}
DEMO_ALLOW_PUBLIC=${DEMO_ALLOW_PUBLIC:-}
STABLERAILS_ENV=${STABLERAILS_ENV:-}
WATCHER_POLL_INTERVAL_MS=${WATCHER_POLL_INTERVAL_MS:-5000}
USDT_RATE_MICRO=${USDT_RATE_MICRO:-}
ENVEOF
chmod 600 ${REMOTE_DIR}/.env
echo "[remote] .env written."
ENV_WRITE

    # ── Start / update compose stack ──────────────────────────────────────────
    info "Starting docker compose stack ..."
    # NOTE: COMPOSE_UP heredoc is intentionally unquoted so the local shell
    # substitutes ${REMOTE_DIR} into the remote script before sending it.
    # shellcheck disable=SC2087
    ssh -o StrictHostKeyChecking=no "${DEPLOY_USER}@${ip}" bash <<COMPOSE_UP
set -euo pipefail
cd ${REMOTE_DIR}
docker compose -f docker-compose.prod.yml pull --quiet 2>/dev/null || true
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
echo "[remote] Stack running:"
docker compose -f docker-compose.prod.yml ps
COMPOSE_UP

    info "=== DEPLOY COMPLETE ==="
    info "Server: https://${DOMAIN}"
    info "Health check: curl https://${DOMAIN}/login"
}

# ── Subcommand: backup ─────────────────────────────────────────────────────────
# Run pg-backup.sh on the remote box immediately (useful for manual/ad-hoc backups).
cmd_backup() {
    local ip="${1:-}"
    [[ -n "$ip" ]] || die "Usage: $0 backup <ip>"

    info "=== BACKUP ==="
    ssh -o StrictHostKeyChecking=no "${DEPLOY_USER}@${ip}" \
        "bash ${REMOTE_DIR}/scripts/pg-backup.sh"
    info "Backup complete."
}

# ── Dispatch ───────────────────────────────────────────────────────────────────
SUBCOMMAND="${1:-}"
case "$SUBCOMMAND" in
    provision) cmd_provision ;;
    dns)       cmd_dns "${2:-}" ;;
    deploy)    cmd_deploy "${2:-}" ;;
    backup)    cmd_backup "${2:-}" ;;
    "")
        echo "Usage: $0 <subcommand> [args]"
        echo ""
        echo "Subcommands:"
        echo "  provision           Create CX22 server + firewall; prints IP"
        echo "  dns <ip>            Set pay.example.com A record → <ip>"
        echo "  deploy <ip>         Sync repo + write .env + docker compose up"
        echo "  backup <ip>         Run pg-backup.sh on remote immediately"
        exit 1
        ;;
    *)
        die "Unknown subcommand: $SUBCOMMAND. Run $0 for usage."
        ;;
esac
