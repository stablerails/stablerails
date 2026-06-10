# Stablerails — Production Deploy Runbook

## Overview

One-box Hetzner CX22 deployment: `postgres` + `server` + `worker` behind Caddy with automatic TLS.

**Watch-only property:** The server never holds private keys or the seed phrase. A breach of the production server moves zero funds. Signing (sweep/cash-out) happens on the **operator's local machine** via the CLI — see `docs/runbook-sweep.md`.

**Domain:** `pay.example.com` → Hetzner CX22 → Caddy → server:3000

---

## Prerequisites

On your local machine (the operator's machine):

- `hcloud` CLI v1.61+ (`brew install hcloud`) with `HCLOUD_TOKEN` in env
- `~/.local/bin/godaddy-dns` accessible (`godaddy-dns set-a example.com pay <ip>`)
- SSH key named `claude-code` uploaded to Hetzner Cloud (default; override with `SSH_KEY_NAME=`)
- Docker installed locally (for compose config validation only)
- All required env vars exported (see `.env.prod.example`)

---

## Step-by-Step: First Deploy

### 1. Provision the server

```bash
export HCLOUD_TOKEN=<your-hetzner-token>

# Creates CX22 (Ubuntu 24.04, Frankfurt by default), firewall (22/80/443), prints IP
./scripts/deploy-hetzner.sh provision
# → "=== Server IP: 1.2.3.4 ==="

SERVER_IP=1.2.3.4   # capture for subsequent steps
```

Idempotent — safe to re-run if interrupted. The firewall allows only ports 22, 80, 443 inbound.

**Decision point:** `SERVER_LOCATION` defaults to `fsn1` (Frankfurt). Override:
```bash
SERVER_LOCATION=hel1 ./scripts/deploy-hetzner.sh provision   # Helsinki
SERVER_LOCATION=ash  ./scripts/deploy-hetzner.sh provision   # Ashburn (US)
```

CX22 gives 2 vCPU / 4 GB RAM / 40 GB NVMe — sufficient for this workload. Upgrade to CX32 (8 GB) if you see OOM kills under heavy webhook delivery load.

### 2. Point DNS

```bash
./scripts/deploy-hetzner.sh dns "$SERVER_IP"
# Calls: godaddy-dns set-a example.com pay 1.2.3.4
```

Wait for propagation (typically 1–5 minutes):
```bash
watch -n 10 "dig +short pay.example.com @8.8.8.8"
# Wait until it returns: 1.2.3.4
```

**Caddy's ACME HTTP-01 challenge requires the A record to resolve before TLS is issued.**

### 3. Prepare env vars

```bash
export POSTGRES_PASSWORD="$(openssl rand -base64 32)"     # strong random; save to 1Password
export TRON_RPC_PRIMARY_URL="https://api.trongrid.io"
export TRON_RPC_SECONDARY_URL="https://rpc.ankr.com/tron" # must differ from primary
export TRON_RPC_PRIMARY_API_KEY="your-trongrid-api-key"
export TRON_RPC_SECONDARY_API_KEY="your-secondary-key"
export PUBLIC_BASE_URL="https://pay.example.com"
export DOMAIN="pay.example.com"
export STABLERAILS_ADMIN_KEY=""   # empty on first deploy; set in step 5
```

See `.env.prod.example` for full variable documentation.

### 4. Deploy

```bash
./scripts/deploy-hetzner.sh deploy "$SERVER_IP"
```

This will:
1. Install Docker on the server (idempotent)
2. Rsync the repo to `/opt/stablerails` (excludes `.git`, `node_modules`, secrets)
3. Write `/opt/stablerails/.env` with your env vars (chmod 600)
4. Run `docker compose -f docker-compose.prod.yml up -d --build`
5. Print the running service list

### 5. Bootstrap operator account + admin key

On first deploy the DB is empty. Run these steps from your local machine:

```bash
# a) Wait for the server to be healthy
curl -s https://pay.example.com/login | grep -q "Stablerails" && echo "OK"

# b) Create the first operator account (direct DB access via SSH)
ssh root@"$SERVER_IP" \
  "cd /opt/stablerails && \
   docker compose -f docker-compose.prod.yml exec server \
   node dist/cli/index.js operator init --email admin@your-domain.com"
# Prompts for password (hidden input)

# c) Log in via API and mint the first admin key
curl -s -c /tmp/up_cookies \
  -X POST https://pay.example.com/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@your-domain.com","password":"<your-password>"}' | jq .

curl -s -b /tmp/up_cookies \
  -X POST https://pay.example.com/v1/api-keys \
  -H "Content-Type: application/json" \
  -d '{"label":"main-admin","scope":"admin"}' | jq .
# Raw key shown ONCE — copy immediately to 1Password

# d) Set STABLERAILS_ADMIN_KEY in the server .env and restart server/worker
ssh root@"$SERVER_IP" bash <<'EOF'
set -euo pipefail
cd /opt/stablerails
# Append or update STABLERAILS_ADMIN_KEY in .env
grep -q '^STABLERAILS_ADMIN_KEY=' .env \
  && sed -i "s|^STABLERAILS_ADMIN_KEY=.*|STABLERAILS_ADMIN_KEY=<your-admin-key>|" .env \
  || echo "STABLERAILS_ADMIN_KEY=<your-admin-key>" >> .env
docker compose -f docker-compose.prod.yml restart server worker
EOF
```

### 6. Verify

```bash
# TLS + health
curl -I https://pay.example.com/login        # HTTP 200, X-Content-Type-Options: nosniff

# API
curl https://pay.example.com/v1/events \
  -H "Authorization: Bearer $STABLERAILS_ADMIN_KEY" | jq .

# Compose status on the box
ssh root@"$SERVER_IP" \
  "docker compose -f /opt/stablerails/docker-compose.prod.yml ps"

# Logs
ssh root@"$SERVER_IP" \
  "docker compose -f /opt/stablerails/docker-compose.prod.yml logs --tail=50 server"
```

---

## Update (Rolling Deploy)

No downtime — compose recreates containers one by one:

```bash
# 1. Push changes to main (or the branch being deployed)
# 2. Run deploy subcommand — it rsyncs the latest working tree and rebuilds
./scripts/deploy-hetzner.sh deploy "$SERVER_IP"
```

If the image didn't change and only env vars changed, restart is sufficient:
```bash
ssh root@"$SERVER_IP" \
  "docker compose -f /opt/stablerails/docker-compose.prod.yml restart server worker"
```

---

## Rollback

```bash
# Option A: re-deploy an older git revision
git checkout <previous-commit>
./scripts/deploy-hetzner.sh deploy "$SERVER_IP"

# Option B: restart from the last successfully built image (no rebuild)
ssh root@"$SERVER_IP" bash <<'EOF'
cd /opt/stablerails
# Roll back to the previous image tag if you have one saved, e.g.:
# docker tag stablerails-deploy-server:previous stablerails-deploy-server:latest
docker compose -f docker-compose.prod.yml up -d --no-build
EOF
```

**Database schema rollbacks** are not supported by Prisma Migrate — if a migration introduces a breaking change, restore from backup before redeploying the old image.

---

## Backups

### Automated (cron)

Set up on the server after first deploy:

```bash
ssh root@"$SERVER_IP" bash <<'EOF'
# Install cron entry (runs at 03:00 UTC daily)
crontab -l 2>/dev/null | \
  { cat; echo "0 3 * * * /opt/stablerails/scripts/pg-backup.sh >> /var/log/stablerails-backup.log 2>&1"; } \
  | crontab -
crontab -l   # verify
EOF
```

Backups are stored in `/opt/stablerails/backups/`. Default retention: last 14 dumps. Override with `RETAIN_LAST=30`.

### Manual backup

```bash
./scripts/deploy-hetzner.sh backup "$SERVER_IP"
# or directly:
ssh root@"$SERVER_IP" /opt/stablerails/scripts/pg-backup.sh
```

### Restore

```bash
# 1. Stop app containers (leave postgres running)
ssh root@"$SERVER_IP" \
  "docker compose -f /opt/stablerails/docker-compose.prod.yml stop server worker"

# 2. Restore dump (replace <backup-file> with the chosen timestamp)
ssh root@"$SERVER_IP" \
  "docker compose -f /opt/stablerails/docker-compose.prod.yml exec -T postgres \
   pg_restore --username=stablerails --dbname=stablerails --clean --if-exists \
   < /opt/stablerails/backups/<backup-file>.pgdump"

# 3. Restart
ssh root@"$SERVER_IP" \
  "docker compose -f /opt/stablerails/docker-compose.prod.yml start server worker"
```

**WARNING:** `--clean` drops and recreates all schema objects. Only restore to a machine where that is intentional — never against a live DB with active traffic.

---

## Secrets Reference

| Secret | Where stored | Used by |
|---|---|---|
| `POSTGRES_PASSWORD` | 1Password + server `.env` | postgres + server + worker |
| `HCLOUD_TOKEN` | 1Password + operator shell | deploy-hetzner.sh |
| `TRON_RPC_PRIMARY_API_KEY` | 1Password + server `.env` | worker |
| `TRON_RPC_SECONDARY_API_KEY` | 1Password + server `.env` | worker |
| `STABLERAILS_ADMIN_KEY` | 1Password + server `.env` | operator CLI |
| `STABLERAILS_ENCRYPTED_SEED` | **operator's local machine only** | local CLI sweep |
| `STABLERAILS_MAIN_WALLET` | **operator's local machine only** | local CLI sweep |

**The last two rows never go on the server.** A compromised server cannot sign or redirect funds.

---

## Architecture Notes

- **Caddy** terminates TLS on ports 80/443. The `server` container is reachable only via the `frontend` compose network — not published to the host.
- **postgres** is on the `backend` compose network only — not exposed to the host or to Caddy.
- **server** migrates the DB at startup via `prisma migrate deploy` (entrypoint) before accepting traffic.
- **worker** starts only after the server is healthy (compose `depends_on: service_healthy`).
- HTTP→HTTPS redirect is handled automatically by Caddy when a domain block is TLS-configured.
- CSP headers are set by `@fastify/helmet` in the app; Caddy adds only transport headers (`HSTS`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).

---

## Decisions Required Before Production

1. **RPC provider / API key** — TronGrid free tier is rate-limited. Obtain paid keys at `trongrid.io` and a second provider (GetBlock, Ankr, NOWNodes). Both must be mainnet.
2. **Server location** — default is `fsn1` (Frankfurt). Choose based on your audience latency. Available: `fsn1`, `nbg1`, `hel1` (EU), `ash` (US-East), `hil` (US-West).
3. **Server size** — CX22 (2 vCPU / 4 GB) is the default. Upgrade to CX32 (4 vCPU / 8 GB) if memory pressure appears under high webhook delivery concurrency.
4. **Backup offsite copy** — the current setup keeps backups on the same box. For production, add an offsite step (e.g. `rclone` to S3/R2/B2) to `pg-backup.sh`.
5. **Alerting** — no monitoring is configured. Consider Uptime Kuma (self-hosted) or Grafana Cloud for health-check alerting.
