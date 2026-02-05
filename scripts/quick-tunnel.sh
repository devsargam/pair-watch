#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PORT=3000
FRONTEND_PORT=3001

SERVER_LOG="$(mktemp)"
FRONTEND_LOG="$(mktemp)"
SERVER_TUNNEL_LOG="$(mktemp)"
FRONTEND_TUNNEL_LOG="$(mktemp)"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" || true
  fi
  if [[ -n "${SERVER_TUNNEL_PID:-}" ]] && kill -0 "$SERVER_TUNNEL_PID" 2>/dev/null; then
    kill "$SERVER_TUNNEL_PID" || true
  fi
  if [[ -n "${FRONTEND_TUNNEL_PID:-}" ]] && kill -0 "$FRONTEND_TUNNEL_PID" 2>/dev/null; then
    kill "$FRONTEND_TUNNEL_PID" || true
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"

pnpm dev:server >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

pnpm dev:frontend >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

cloudflared tunnel --url "http://localhost:${SERVER_PORT}" --logfile "$SERVER_TUNNEL_LOG" --loglevel info &
SERVER_TUNNEL_PID=$!

cloudflared tunnel --url "http://localhost:${FRONTEND_PORT}" --logfile "$FRONTEND_TUNNEL_LOG" --loglevel info &
FRONTEND_TUNNEL_PID=$!

SERVER_URL=""
FRONTEND_URL=""

for _ in {1..30}; do
  if [[ -z "$SERVER_URL" ]]; then
    SERVER_URL=$(rg -m1 -o "https://[a-z0-9-]+\.trycloudflare\.com" "$SERVER_TUNNEL_LOG" || true)
  fi
  if [[ -z "$FRONTEND_URL" ]]; then
    FRONTEND_URL=$(rg -m1 -o "https://[a-z0-9-]+\.trycloudflare\.com" "$FRONTEND_TUNNEL_LOG" || true)
  fi
  if [[ -n "$SERVER_URL" && -n "$FRONTEND_URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$SERVER_URL" || -z "$FRONTEND_URL" ]]; then
  echo "Failed to detect tunnel URLs. Check logs:" >&2
  echo "Server tunnel log: $SERVER_TUNNEL_LOG" >&2
  echo "Frontend tunnel log: $FRONTEND_TUNNEL_LOG" >&2
  exit 1
fi

cat <<EOT
NEXT_PUBLIC_SERVER_URL=$SERVER_URL
EOT > "$ROOT_DIR/.env.local"

if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
  kill "$FRONTEND_PID" || true
  pnpm dev:frontend >"$FRONTEND_LOG" 2>&1 &
  FRONTEND_PID=$!
fi

cat <<EOT
Cloudflare tunnels are up:
- Server:   $SERVER_URL
- Frontend: $FRONTEND_URL

.env.local has been updated and the frontend restarted.

Open:
$FRONTEND_URL

Press Ctrl+C to stop everything.
EOT

while true; do
  sleep 1
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server process stopped."
    break
  fi
  if ! kill -0 "$SERVER_TUNNEL_PID" 2>/dev/null; then
    echo "Server tunnel stopped."
    break
  fi
  if ! kill -0 "$FRONTEND_TUNNEL_PID" 2>/dev/null; then
    echo "Frontend tunnel stopped."
    break
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "Frontend process stopped. Restarting..."
    pnpm dev:frontend >"$FRONTEND_LOG" 2>&1 &
    FRONTEND_PID=$!
  fi
  done
