#!/bin/bash
set -eu

CONFIG_DIR="/etc/janus"
TEMPLATE_DIR="/var/lib/janus-config-template"

JANUS_HTTP_PORT="${JANUS_HTTP_PORT:-8088}"
JANUS_WS_PORT="${JANUS_WS_PORT:-8188}"
JANUS_RTP_PORT_RANGE="${JANUS_RTP_PORT_RANGE:-40001-45000}"
JANUS_DEBUG_LEVEL="${JANUS_DEBUG_LEVEL:-4}"

case "$JANUS_HTTP_PORT:$JANUS_WS_PORT:$JANUS_DEBUG_LEVEL" in
    *[!0-9:]*)
        echo "ERROR: Janus port variables and JANUS_DEBUG_LEVEL must be numeric" >&2
        exit 1
        ;;
esac

case "$JANUS_RTP_PORT_RANGE" in
    *[!0-9:-]*)
        echo "ERROR: JANUS_RTP_PORT_RANGE must be a min-max numeric range" >&2
        exit 1
        ;;
esac

copy_template() {
    src="$1"
    dst="$CONFIG_DIR/$src"
    tmp="$(mktemp "$CONFIG_DIR/$src.XXXXXX")"
    cp "$TEMPLATE_DIR/$src" "$tmp"
    sed -i \
        -e "s|__JANUS_HTTP_PORT__|$JANUS_HTTP_PORT|g" \
        -e "s|__JANUS_WS_PORT__|$JANUS_WS_PORT|g" \
        -e "s|__JANUS_RTP_PORT_RANGE__|$JANUS_RTP_PORT_RANGE|g" \
        -e "s|__JANUS_DEBUG_LEVEL__|$JANUS_DEBUG_LEVEL|g" \
        "$tmp"
    mv "$tmp" "$dst"
}

copy_template janus.jcfg
copy_template janus.transport.http.jcfg
copy_template janus.transport.websockets.jcfg
copy_template janus.plugin.videoroom.jcfg

JANUS_ARGS=(
    -F "$CONFIG_DIR"
    --log-stdout
    --disable-colors
    --rtp-port-range "$JANUS_RTP_PORT_RANGE"
)

if [ -n "${PUBLIC_IPV4:-}" ]; then
    JANUS_ARGS+=(--interface "$PUBLIC_IPV4")
fi

if [ -n "${PUBLIC_IPV6:-}" ]; then
    JANUS_ARGS+=(--ipv6-candidates)
fi

if [ -n "${JANUS_NAT_1_1_IP:-}" ]; then
    JANUS_ARGS+=(--nat-1-1 "$JANUS_NAT_1_1_IP")
fi

exec janus "${JANUS_ARGS[@]}"
