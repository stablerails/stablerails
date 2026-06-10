#!/bin/sh
set -e

SERVICE="${1:-server}"

echo "[entrypoint] service=$SERVICE"

# Run migrations on the server container only (not the worker, to avoid races).
# The worker waits for the server to be healthy before starting.
if [ "$SERVICE" = "server" ]; then
  echo "[entrypoint] running prisma migrate deploy..."
  npx prisma migrate deploy
  echo "[entrypoint] migrations done"
fi

case "$SERVICE" in
  server)
    echo "[entrypoint] starting HTTP server (dist/index.js)"
    exec node dist/index.js
    ;;
  worker)
    echo "[entrypoint] starting block watcher + webhook worker (dist/workers/index.js)"
    exec node dist/workers/index.js
    ;;
  *)
    echo "[entrypoint] unknown service: $SERVICE"
    exit 1
    ;;
esac
