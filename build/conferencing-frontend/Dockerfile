FROM node:26.8.2-trixie-slim@sha256:f7bb8247fdb16250dbec7fd0e24f091c6f5f0a29d256f3aef5816a7a369166b2

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    curl \
    libcap2-bin \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/run/conferencing-frontend /opt/dvrtc-conferencing-frontend/app /usr/share/dvrtc \
    && chown -R node:node /opt/run/conferencing-frontend /opt/dvrtc-conferencing-frontend/app

WORKDIR /opt/dvrtc-conferencing-frontend/app

COPY --chown=node:node app/ /opt/dvrtc-conferencing-frontend/app/

RUN if [ -f package-lock.json ]; then \
        npm ci --omit=dev; \
    elif [ -f package.json ]; then \
        npm install --omit=dev; \
    fi

COPY --chmod=755 --chown=node:node run.sh /opt/run/conferencing-frontend/run.sh
COPY --chmod=755 healthcheck/healthcheck.sh /usr/local/bin/conferencing-frontend-healthcheck

ARG DVRTC_VERSION=dev
ARG DVRTC_SERVICE=conferencing-frontend
ARG VCS_REF=unknown
ARG DVRTC_SOURCE=https://github.com/EnableSecurity/DVRTC

LABEL org.opencontainers.image.title="DVRTC ${DVRTC_SERVICE}" \
      org.opencontainers.image.version="${DVRTC_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="${DVRTC_SOURCE}"

RUN cat > /usr/share/dvrtc/version.json <<EOF
{
  "product": "dvrtc",
  "service": "${DVRTC_SERVICE}",
  "version": "${DVRTC_VERSION}",
  "revision": "${VCS_REF}"
}
EOF

RUN setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"

ENV NODE_ENV=production
ENV FRONTEND_PORT=80
ENV FRONTEND_HTTPS_PORT=443
ENV FRONTEND_APP_DIR=/opt/dvrtc-conferencing-frontend/app

USER node

WORKDIR /opt/run/conferencing-frontend

CMD ["./run.sh"]
