#!/bin/sh
set -eu

PORT="${JANUS_HTTP_PORT:-8088}"
BODY="$(curl -gfsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${PORT}/janus/info" 2>/dev/null || true)"

[ -n "$BODY" ] || exit 1
printf '%s\n' "$BODY" | grep -q '"janus"'
