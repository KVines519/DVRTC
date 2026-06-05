#!/bin/sh
set -eu

APP_DIR="${BOT_APP_DIR:-/opt/dvrtc-bluepill-aiortc-bots/app}"

if [ ! -d "$APP_DIR" ]; then
    echo "ERROR: BOT_APP_DIR does not exist: $APP_DIR" >&2
    exit 1
fi

cd "$APP_DIR"

exec python3 bot.py
