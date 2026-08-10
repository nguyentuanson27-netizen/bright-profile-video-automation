FROM node:24.18.0-bookworm-slim AS prod-deps

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --strict-allow-scripts=true --no-audit --no-fund

FROM node:24.18.0-bookworm-slim AS web-build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --strict-allow-scripts=true --no-audit --no-fund
COPY vite.config.mjs ./
COPY web ./web
RUN npm run build

FROM node:24.18.0-bookworm-slim AS runtime

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg fonts-noto-core fonts-noto-extra ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server.mjs worker.mjs ./
COPY --chown=node:node app ./app
COPY --chown=node:node domain ./domain
COPY --chown=node:node lib ./lib
COPY --chown=node:node providers ./providers
COPY --chown=node:node security ./security
COPY --chown=node:node storage ./storage
COPY --chown=node:node worker ./worker
COPY --chown=node:node video ./video
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node assets ./assets
COPY --from=web-build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data

USER node
ENV NODE_ENV=production \
    REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium \
    PORT=4180 \
    WORKER_OPS_PORT=4181 \
    DATA_DIR=/app/data
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4180/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
