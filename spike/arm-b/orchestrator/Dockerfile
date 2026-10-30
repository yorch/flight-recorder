FROM node:26-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY harness/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY harness ./harness

USER node
WORKDIR /app/harness
ENTRYPOINT ["node", "main.ts"]
