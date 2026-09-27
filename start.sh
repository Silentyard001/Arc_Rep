#!/bin/sh
# Arc Rep — Production startup + process supervisor
#
# Runs:
#   1. Express API server on PORT (default 3001) — restarted on crash
#   2. Static frontend served on FRONTEND_PORT (default 8080)
#
# Both processes write to stdout/stderr. A trap on EXIT ensures the
# frontend is stopped when the supervisor itself exits.
#
# Deployment verification:
#   GET /health returns {"startedAt": "<ISO>", "provider": "<name>", ...}
#   Compare "startedAt" after deployment to confirm new code is live.

set -e

# ── Required environment checks ──────────────────────────────────────────────
# Fail loudly if the minimum configuration is absent rather than starting
# in a degraded state that silently produces wrong results.
if [ -z "$RPC_PROXY_BASE_URL" ]; then
  echo "[arc-rep] FATAL: RPC_PROXY_BASE_URL is not set. Cannot start." >&2
  exit 1
fi
if [ -z "$RPC_PROXY_TOKEN" ]; then
  echo "[arc-rep] FATAL: RPC_PROXY_TOKEN is not set. Cannot start." >&2
  exit 1
fi
if [ -z "$RPC_PROXY_CHAINS" ]; then
  echo "[arc-rep] FATAL: RPC_PROXY_CHAINS is not set. Cannot start." >&2
  exit 1
fi

# Optional: log which provider will be used so deployment can be verified
# in startup logs without querying the health endpoint.
if [ -n "$GOLDSKY_POSTGRES_URL" ]; then
  echo "[arc-rep] Provider: GoldskyActivityProvider (historical)"
else
  echo "[arc-rep] Provider: ArcRpcProvider (RPC window only — partial history)"
fi

FRONTEND_PORT="${FRONTEND_PORT:-8080}"
API_PORT="${PORT:-3001}"

# ── Frontend (static) ────────────────────────────────────────────────────────
echo "[arc-rep] Starting static frontend on port $FRONTEND_PORT..."
bunx serve -s dist -l "$FRONTEND_PORT" &
FRONTEND_PID=$!

# Ensure frontend is stopped when this script exits
trap 'kill $FRONTEND_PID 2>/dev/null; exit' INT TERM EXIT

# ── API server (with restart loop) ───────────────────────────────────────────
echo "[arc-rep] Starting API server on port $API_PORT..."

MAX_RESTARTS=10
RESTART_DELAY=3
restart_count=0

while true; do
  bun run server/index.ts &
  API_PID=$!
  wait $API_PID
  EXIT_CODE=$?

  # Exit code 0 = intentional shutdown (SIGTERM from deployment)
  if [ $EXIT_CODE -eq 0 ]; then
    echo "[arc-rep] API server exited cleanly (code 0). Shutting down."
    break
  fi

  restart_count=$((restart_count + 1))
  echo "[arc-rep] API server exited with code $EXIT_CODE (restart $restart_count/$MAX_RESTARTS). Restarting in ${RESTART_DELAY}s..." >&2

  if [ $restart_count -ge $MAX_RESTARTS ]; then
    echo "[arc-rep] FATAL: API server failed $MAX_RESTARTS times. Stopping." >&2
    kill $FRONTEND_PID 2>/dev/null
    exit 1
  fi

  sleep $RESTART_DELAY
done

# Stop frontend when API loop ends cleanly
kill $FRONTEND_PID 2>/dev/null
