FROM debian:sid-slim@sha256:17d1843dae9ca66f1617c1e464f40d06059ccefb0c606e8b54687f253af1684e

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    janus \
    janus-tools \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -u 15005 janus || usermod -u 15005 janus || true
RUN mkdir -p /var/lib/janus-config-template /var/log/janus /var/run/janus /opt/run/janus \
    && chown -R janus:janus /var/log/janus /var/run/janus /opt/run/janus

COPY config/ /etc/janus/
RUN cp /etc/janus/janus.jcfg /var/lib/janus-config-template/janus.jcfg && \
    cp /etc/janus/janus.transport.http.jcfg /var/lib/janus-config-template/janus.transport.http.jcfg && \
    cp /etc/janus/janus.transport.websockets.jcfg /var/lib/janus-config-template/janus.transport.websockets.jcfg && \
    cp /etc/janus/janus.plugin.videoroom.jcfg /var/lib/janus-config-template/janus.plugin.videoroom.jcfg && \
    chown -R janus:janus /etc/janus /var/lib/janus-config-template

COPY --chmod=755 healthcheck/healthcheck.sh /usr/local/bin/janus-healthcheck
COPY --chmod=755 --chown=janus:janus run.sh /opt/run/janus/run.sh

ARG DVRTC_VERSION=dev
ARG DVRTC_SERVICE=janus
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

USER janus

WORKDIR /opt/run/janus

CMD ["./run.sh"]
