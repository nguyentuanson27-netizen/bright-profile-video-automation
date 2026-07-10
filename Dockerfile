FROM node:24-bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg fonts-noto-core fonts-noto-extra ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY lib ./lib
COPY video ./video
COPY scripts ./scripts
COPY assets ./assets
COPY examples ./examples
RUN mkdir -p /app/data && chown -R node:node /app

USER node
ENV NODE_ENV=production REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium PORT=4180 DATA_DIR=/app/data
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4180/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
