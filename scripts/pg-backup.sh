#!/usr/bin/env bash
# pg-backup.sh — PostgreSQL backup for Stablerails compose stack
#
# Dumps the stablerails database from the running postgres container to a
# timestamped file, then prunes old backups to keep only the last N.
#
# Designed to run on the server (where docker compose is running).
# Safe to run from cron or manually via `deploy-hetzner.sh backup <ip>`.
#
# CRONTAB LINE (add via `crontab -e` on the server as root):
#   0 3 * * * /opt/stablerails/scripts/pg-backup.sh >> /var/log/stablerails-backup.log 2>&1
# This runs at 03:00 UTC daily and keeps logs in /var/log/stablerails-backup.log.
#
# Configuration (env vars, all optional — defaults shown):
#   BACKUP_DIR      — where to store dumps  (default: /opt/stablerails/backups)
#   RETAIN_LAST     — how many dumps to keep (default: 14)
#   COMPOSE_FILE    — compose file path      (default: /opt/stablerails/docker-compose.prod.yml)
#   POSTGRES_USER   — DB user                (default: stablerails)
#   POSTGRES_DB     — DB name                (default: stablerails)

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/opt/stablerails/backups}"
RETAIN_LAST="${RETAIN_LAST:-14}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/stablerails/docker-compose.prod.yml}"
POSTGRES_USER="${POSTGRES_USER:-stablerails}"
POSTGRES_DB="${POSTGRES_DB:-stablerails}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/stablerails_${TIMESTAMP}.pgdump"

# ── Helpers ───────────────────────────────────────────────────────────────────
info() { echo "[pg-backup] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }
die()  { echo "[pg-backup][ERROR] $*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v docker &>/dev/null || die "docker not found"
[[ -f "$COMPOSE_FILE" ]]     || die "Compose file not found: $COMPOSE_FILE"

mkdir -p "$BACKUP_DIR"

# ── Verify postgres container is running ──────────────────────────────────────
CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)"
[[ -n "$CONTAINER" ]] || die "postgres container is not running (compose: $COMPOSE_FILE)"

# ── Dump ──────────────────────────────────────────────────────────────────────
info "Starting backup → $BACKUP_FILE"

# pg_dump in custom format (compressed, efficient restore via pg_restore)
docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump \
        --username="$POSTGRES_USER" \
        --format=custom \
        --no-password \
        "$POSTGRES_DB" \
    > "$BACKUP_FILE"

# Verify the dump file is non-empty
[[ -s "$BACKUP_FILE" ]] || { rm -f "$BACKUP_FILE"; die "Dump file is empty — backup failed."; }

FILESIZE="$(du -sh "$BACKUP_FILE" | cut -f1)"
info "Backup complete: $BACKUP_FILE ($FILESIZE)"

# ── Prune old backups ─────────────────────────────────────────────────────────
# List files sorted oldest-first; delete all but the last RETAIN_LAST.
BACKUP_COUNT="$(find "$BACKUP_DIR" -name 'stablerails_*.pgdump' | wc -l)"
info "Current backup count: $BACKUP_COUNT (retain last: $RETAIN_LAST)"

if [[ "$BACKUP_COUNT" -gt "$RETAIN_LAST" ]]; then
    DELETE_COUNT=$(( BACKUP_COUNT - RETAIN_LAST ))
    info "Pruning $DELETE_COUNT old backup(s) ..."
    find "$BACKUP_DIR" -name 'stablerails_*.pgdump' -print0 \
        | sort -z \
        | head -z -n "$DELETE_COUNT" \
        | xargs -0 rm -v
    info "Pruning done."
fi

info "Backup directory contents:"
ls -lh "$BACKUP_DIR"/*.pgdump 2>/dev/null || info "(no backups yet)"

# ── Restore instructions (printed on each run for operator awareness) ─────────
cat <<'RESTORE_HINT'

To restore from a backup:
  docker compose -f /opt/stablerails/docker-compose.prod.yml exec -T postgres \
    pg_restore --username=stablerails --dbname=stablerails --clean --if-exists \
    < /opt/stablerails/backups/<backup-file>.pgdump

WARNING: --clean drops and recreates all objects. Run against a stopped app
or a restore target, not against the live production database.

RESTORE_HINT
