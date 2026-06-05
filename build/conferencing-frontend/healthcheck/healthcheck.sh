#!/bin/sh
set -eu

PORT="${FRONTEND_PORT:-80}"
BODY="$(curl -gfsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"

[ "$BODY" = "ok" ]
