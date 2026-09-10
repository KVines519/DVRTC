FROM --platform=$BUILDPLATFORM golang:1.27.1-trixie@sha256:9baa6b4187bbb98d240372a8a235ac0bb6b5ddd52bba1431dc2f7c0705862728 AS sipexer-builder
ARG TARGETOS=linux TARGETARCH=amd64
ARG SIPEXER_REF=6aa6d712e930e8d2739e9ac77866980834337151

# Build sipexer from main branch - v1.2.0 release lacks WS/WSS transport support
# Cross-compile natively to avoid QEMU crashes under emulation
RUN git init /sipexer && \
    cd /sipexer && \
    git remote add origin https://github.com/miconda/sipexer.git && \
    git fetch --depth=1 origin "${SIPEXER_REF}" && \
    git checkout --detach FETCH_HEAD && \
    go get golang.org/x/net@v0.56.0 && \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /usr/local/bin/sipexer .

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132
ARG KAMAILIO_VERSION=61

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Add Kamailio repository
RUN wget -qO- https://deb.kamailio.org/kamailiodebkey.gpg | gpg --dearmor -o /usr/share/keyrings/kamailio.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio${KAMAILIO_VERSION} trixie main" > /etc/apt/sources.list.d/kamailio.list

# Install Kamailio with required modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    kamailio \
    kamailio-mysql-modules \
    kamailio-tls-modules \
    kamailio-websocket-modules \
    kamailio-utils-modules \
    kamailio-json-modules \
    default-mysql-client \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy protocols file (required for TCP/UDP protocol lookups)
COPY protocols /etc/protocols

RUN mkdir -p /etc/certstore

RUN useradd -u 15000 kamailio || true
RUN mkdir -p /var/run/kamailio/ && chown kamailio /var/run/kamailio

# Copy sipexer binary from builder stage
COPY --from=sipexer-builder /usr/local/bin/sipexer /usr/local/bin/sipexer

COPY config/ /etc/kamailio/

# Copy health check script
COPY --chmod=755 healthcheck/healthcheck.sh /usr/local/bin/kamailio-healthcheck

WORKDIR /opt/run/kamailio

COPY run.sh run.sh

ARG DVRTC_VERSION=dev
ARG DVRTC_SERVICE=kamailio
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
