# syntax=docker/dockerfile:1
FROM node:26-trixie-slim

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg xdotool x11-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

USER node
ENV TZ=UTC
ENTRYPOINT ["node", "src/main.ts"]
