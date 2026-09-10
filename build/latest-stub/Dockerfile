FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

ARG DVRTC_VERSION=dev
ARG DVRTC_SERVICE=unknown
ARG VCS_REF=unknown
ARG DVRTC_SOURCE=https://github.com/EnableSecurity/DVRTC
ARG TARGET_IMAGE=unknown

LABEL org.opencontainers.image.title="DVRTC ${DVRTC_SERVICE} latest stub" \
      org.opencontainers.image.version="${DVRTC_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="${DVRTC_SOURCE}"

ENV DVRTC_VERSION="${DVRTC_VERSION}" \
    DVRTC_SERVICE="${DVRTC_SERVICE}" \
    TARGET_IMAGE="${TARGET_IMAGE}"

RUN mkdir -p /usr/share/dvrtc && cat > /usr/share/dvrtc/version.json <<EOF
{
  "product": "dvrtc",
  "service": "${DVRTC_SERVICE}",
  "version": "${DVRTC_VERSION}",
  "revision": "${VCS_REF}"
}
EOF

COPY --chmod=755 entrypoint.sh /usr/local/bin/latest-stub

ENTRYPOINT ["/usr/local/bin/latest-stub"]
