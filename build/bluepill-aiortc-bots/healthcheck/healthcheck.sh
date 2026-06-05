#!/bin/sh
set -eu

pgrep -f "python3 bot.py" >/dev/null || exit 1
[ -f /tmp/bluepill-aiortc-bots.heartbeat ] || exit 1
find /tmp -name bluepill-aiortc-bots.heartbeat -mmin -2 | grep -q .
