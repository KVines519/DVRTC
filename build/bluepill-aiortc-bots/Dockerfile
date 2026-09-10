# DVRTC bluepill-aiortc-bots - lightweight aiortc publishers that occupy a
# BluePill Meeting room without launching browser engines.

FROM python:3.14.7-slim-trixie@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        procps \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin botuser \
    && mkdir -p /opt/dvrtc-bluepill-aiortc-bots/app \
                /opt/dvrtc-bluepill-aiortc-bots/media \
                /opt/run/bluepill-aiortc-bots \
                /usr/share/dvrtc \
    && chown -R botuser:botuser /opt/dvrtc-bluepill-aiortc-bots /opt/run/bluepill-aiortc-bots

WORKDIR /opt/dvrtc-bluepill-aiortc-bots/app

COPY --chown=botuser:botuser build/bluepill-aiortc-bots/app/requirements.txt /opt/dvrtc-bluepill-aiortc-bots/app/
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y pip

COPY --chown=botuser:botuser build/bluepill-aiortc-bots/app/ /opt/dvrtc-bluepill-aiortc-bots/app/
COPY --chown=botuser:botuser build/bluepill-aiortc-bots/media/ /opt/dvrtc-bluepill-aiortc-bots/media/

ARG BOT_AIORTC_VIDEO_WIDTH=160
ARG BOT_AIORTC_VIDEO_HEIGHT=120
ARG BOT_AIORTC_VIDEO_FPS=30
RUN set -eu; \
    cd /opt/dvrtc-bluepill-aiortc-bots/media; \
    gen_wave_video() { \
        name="$1"; wav="$2"; out="$3"; \
        wave_w=$((BOT_AIORTC_VIDEO_WIDTH - 20)); \
        wave_h=$((BOT_AIORTC_VIDEO_HEIGHT - 36)); \
        if [ -f "$wav" ]; then \
            duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$wav"); \
            ffmpeg -hide_banner -loglevel error -y -i "$wav" \
                -filter_complex "[0:a]aformat=channel_layouts=mono,showwaves=s=${wave_w}x${wave_h}:mode=p2p:colors=0xb8ffd0:rate=${BOT_AIORTC_VIDEO_FPS}:scale=cbrt:draw=full,eq=brightness=0.10:saturation=1.8,format=rgba[vis];color=c=0x001a08:s=${BOT_AIORTC_VIDEO_WIDTH}x${BOT_AIORTC_VIDEO_HEIGHT}:r=${BOT_AIORTC_VIDEO_FPS}:d=${duration}[bg];[bg][vis]overlay=10:18:shortest=1,format=yuv420p[v]" \
                -map "[v]" -an -shortest \
                -c:v libx264 -profile:v baseline -level 3.1 -preset veryfast -tune zerolatency \
                -x264-params "bframes=0:keyint=$((BOT_AIORTC_VIDEO_FPS * 2)):min-keyint=$((BOT_AIORTC_VIDEO_FPS * 2)):scenecut=0" \
                -pix_fmt yuv420p -f mpegts "$out"; \
        else \
            echo "WARNING: $wav missing; generating static fallback video for $name" >&2; \
            ffmpeg -hide_banner -loglevel error -y \
                -f lavfi -i "color=c=0x001a08:s=${BOT_AIORTC_VIDEO_WIDTH}x${BOT_AIORTC_VIDEO_HEIGHT}:d=10:r=${BOT_AIORTC_VIDEO_FPS}" \
                -c:v libx264 -profile:v baseline -level 3.1 -preset veryfast -tune zerolatency \
                -x264-params "bframes=0:keyint=$((BOT_AIORTC_VIDEO_FPS * 2)):min-keyint=$((BOT_AIORTC_VIDEO_FPS * 2)):scenecut=0" \
                -pix_fmt yuv420p -f mpegts "$out"; \
        fi; \
        echo "  generated $out for $name"; \
    }; \
    gen_wave_video Neo neo.wav neo.ts; \
    gen_wave_video Morpheus morpheus.wav morpheus.ts; \
    ls -lh neo.ts morpheus.ts

COPY --chmod=755 --chown=botuser:botuser build/bluepill-aiortc-bots/run.sh /opt/run/bluepill-aiortc-bots/run.sh
COPY --chmod=755 build/bluepill-aiortc-bots/healthcheck/healthcheck.sh /usr/local/bin/bluepill-bots-healthcheck

ARG DVRTC_VERSION=dev
ARG DVRTC_SERVICE=bluepill-aiortc-bots
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

ENV PYTHONUNBUFFERED=1
ENV BOT_APP_DIR=/opt/dvrtc-bluepill-aiortc-bots/app
ENV BOT_MEDIA_DIR=/opt/dvrtc-bluepill-aiortc-bots/media

USER botuser

WORKDIR /opt/run/bluepill-aiortc-bots

CMD ["./run.sh"]
