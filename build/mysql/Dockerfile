FROM --platform=$BUILDPLATFORM golang:1.27.1-trixie@sha256:9baa6b4187bbb98d240372a8a235ac0bb6b5ddd52bba1431dc2f7c0705862728 AS gosu-builder
ARG TARGETOS=linux TARGETARCH=amd64
ARG GOSU_REF=6456aaa0f3c854d199d0f037f068eb97515b7513

RUN git init /gosu && \
    cd /gosu && \
    git remote add origin https://github.com/tianon/gosu.git && \
    git fetch --depth=1 origin "${GOSU_REF}" && \
    git checkout --detach FETCH_HEAD && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags '-d -w' -o /usr/local/bin/gosu .

FROM mysql:9.7.2@sha256:b2cf29815e62fea06b7de22b8b8e57dfe0eb32706e38ce951930bde6faef4ab6

RUN microdnf remove -y mysql-shell && microdnf clean all
COPY --from=gosu-builder /usr/local/bin/gosu /usr/local/bin/gosu

# Copy validation script
COPY validate-and-start.sh /usr/local/bin/validate-and-start.sh
RUN chmod +x /usr/local/bin/validate-and-start.sh

ARG DVRTC_VERSION=dev
ARG DVRTC_SERVICE=db
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

# Use our validation script as entrypoint wrapper
ENTRYPOINT ["/usr/local/bin/validate-and-start.sh"]
CMD ["mysqld", "--mysqlx=0"]
