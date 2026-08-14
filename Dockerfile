FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html vite.config.mjs ./
COPY web ./web
RUN npm run build:web

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime-deps

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg fonts-noto-core fonts-noto-extra ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/package.json /app/package-lock.json ./
COPY --from=web-build --chown=node:node /app/dist ./dist
COPY --chown=node:node server.mjs worker.mjs ./
COPY --chown=node:node app ./app
COPY --chown=node:node domain ./domain
COPY --chown=node:node providers ./providers
COPY --chown=node:node security ./security
COPY --chown=node:node storage ./storage
COPY --chown=node:node worker ./worker
COPY --chown=node:node lib ./lib
COPY --chown=node:node video ./video
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node assets ./assets

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
ENV NODE_ENV=production \
    REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium \
    BRIGHT_DATA_DIR=/app/data \
    BRIGHT_DATABASE_PATH=/app/data/bright-profile.sqlite \
    PORT=4180

EXPOSE 4180
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4180/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
