#!/bin/sh
set -eu

APP_DIR="${FRONTEND_APP_DIR:-/opt/dvrtc-conferencing-frontend/app}"
PORT="${FRONTEND_PORT:-80}"
HTTPS_PORT="${FRONTEND_HTTPS_PORT:-443}"

case "$PORT:$HTTPS_PORT" in
    *[!0-9:]*|:*|*:)
        echo "ERROR: FRONTEND_PORT and FRONTEND_HTTPS_PORT must be numeric" >&2
        exit 1
        ;;
esac

if [ ! -d "$APP_DIR" ]; then
    echo "ERROR: FRONTEND_APP_DIR does not exist: $APP_DIR" >&2
    exit 1
fi

cd "$APP_DIR"

if [ -n "${FRONTEND_START_COMMAND:-}" ]; then
    exec sh -c "$FRONTEND_START_COMMAND"
fi

if [ -f package.json ] && node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts.start ? 0 : 1)' >/dev/null 2>&1; then
    exec npm run start
fi

if [ -f server.js ]; then
    exec node server.js
fi

echo "ERROR: no Node entrypoint found in $APP_DIR" >&2
echo "Add FRONTEND_START_COMMAND, a package.json start script, or server.js." >&2
exit 1
