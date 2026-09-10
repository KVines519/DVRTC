FROM debian:sid-slim@sha256:17d1843dae9ca66f1617c1e464f40d06059ccefb0c606e8b54687f253af1684e

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    asterisk \
    asterisk-modules \
    asterisk-core-sounds-en \
    asterisk-moh-opsound-wav \
    libopus0 \
    && rm -rf /var/lib/apt/lists/*

# Create asterisk user with UID 100 (must match voicemailcleaner)
# May already exist from package, so ignore failures
RUN useradd -u 100 asterisk || usermod -u 100 asterisk || true

# Copy configuration files
COPY config/ /etc/asterisk/
RUN mkdir -p /var/lib/asterisk-config-template && \
    cp /etc/asterisk/pjsip.conf /var/lib/asterisk-config-template/pjsip.conf

# Copy health check script
COPY --chmod=755 healthcheck/healthcheck.sh /usr/local/bin/asterisk-healthcheck

WORKDIR /opt/run/asterisk

COPY run.sh run.sh

ARG DVRTC_VERSION=dev
ARG DVRTC_SERVICE=asterisk
ARG VCS_REF=unknown
ARG DVRTC_SOURCE=https://github.com/EnableSecurity/DVRTC

LABEL org.opencontainers.image.title="DVRTC ${DVRTC_SERVICE}" \
      org.opencontainers.image.version="${DVRTC_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="${DVRTC_SOURCE}"

RUN mkdir -p /usr/share/dvrtc && cat > /usr/share/dvrtc/version.json <<EOF
{
  "product": "dvrtc",
  "service": "${DVRTC_SERVICE}",
  "version": "${DVRTC_VERSION}",
  "revision": "${VCS_REF}"
}
EOF

CMD ["./run.sh"]
