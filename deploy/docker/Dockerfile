ARG VRRELAY_VERSION=0.1.0
FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY apps/relay/package.json apps/relay/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/adapters/package.json packages/adapters/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM debian:bookworm-slim AS ffmpeg
ARG TARGETARCH
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils && \
    rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) \
        archive='ffmpeg-n7.1.5-1-g7d0e842004-linux64-gpl-7.1.tar.xz'; \
        sha256='f0c580f5f12af54e8c9c649c70b2d25f264edb35393203d34b20cf4f9c126288' ;; \
      arm64) \
        archive='ffmpeg-n7.1.5-1-g7d0e842004-linuxarm64-gpl-7.1.tar.xz'; \
        sha256='8b61e22e674c9f3530a8953a684d6789dd94de26fffd614b9234b15673b85d04' ;; \
      *) echo "Unsupported FFmpeg architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 \
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/$archive" \
      --output /tmp/ffmpeg.tar.xz; \
    echo "$sha256  /tmp/ffmpeg.tar.xz" | sha256sum --check --strict; \
    mkdir -p /opt/ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1; \
    /opt/ffmpeg/bin/ffmpeg -hide_banner -version | grep -F '7.1.5'; \
    /opt/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -F 'libx264'; \
    /opt/ffmpeg/bin/ffmpeg -hide_banner -filters | grep -F 'subtitles'

FROM node:22.23.1-bookworm-slim
ARG VRRELAY_VERSION
LABEL org.opencontainers.image.title="VRRelay" \
      org.opencontainers.image.version="$VRRELAY_VERSION" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/tdeverx/VRRelay"
WORKDIR /app
ENV NODE_ENV=production \
    VRRELAY_VERSION=$VRRELAY_VERSION \
    VRRELAY_DATA_DIR=/data \
    VRRELAY_CACHE_DIR=/cache
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffmpeg
COPY --from=ffmpeg /opt/ffmpeg/bin/ffprobe /opt/ffmpeg/bin/ffprobe
ENV PATH="/opt/ffmpeg/bin:$PATH"
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/relay ./apps/relay
COPY --from=build /app/packages ./packages
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build /app/deploy/runtime-manifest.json ./deploy/runtime-manifest.json
RUN mkdir -p /data /cache /tmp/vrrelay && chown -R node:node /data /cache /tmp/vrrelay
USER node
EXPOSE 8099
VOLUME ["/data", "/cache"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8099/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/relay/dist/main.js"]
