#!/bin/sh
set -eu

TARGET_INPUT="${1:-${PUBLIC_IPV4:-}}"
TARGET_MYSQL_PORT="${2:-${MYSQL_PORT:-23306}}"
SCENARIO="${SCENARIO:-pbx1}"

if [ -z "${TARGET_INPUT}" ]; then
    echo "usage: attacker-run-all <target-ip> [mysql-port]" >&2
    echo "or set PUBLIC_IPV4 in the environment" >&2
    exit 2
fi

if [ "${SCENARIO}" = "conferencing1" ]; then
    exec env \
        SCENARIO="${SCENARIO}" \
        CONFERENCING_SKIP_LOCAL_JANUS=1 \
        testing-run-all "${TARGET_INPUT}" "${TARGET_MYSQL_PORT}"
fi

digest_leak_check=1
if [ "${SCENARIO}" = "pbx2" ]; then
    digest_leak_check=0
fi

exec env \
    SCENARIO="${SCENARIO}" \
    RUN_CALLGEN_CHECK=0 \
    RUN_DIGESTLEAK_REG_CHECK=0 \
    RUN_DIGESTLEAK_AUTH_CHECK=0 \
    RUN_DIGESTLEAK_PUBLIC_BLOCK_CHECK=1 \
    RUN_DIGEST_LEAK_CHECK="${digest_leak_check}" \
    testing-run-all "${TARGET_INPUT}" "${TARGET_MYSQL_PORT}"
