FROM node:26-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg xdotool x11-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY proxy/harness/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY proxy/harness ./harness

USER node
WORKDIR /app/harness
ENTRYPOINT ["node", "main.ts"]
