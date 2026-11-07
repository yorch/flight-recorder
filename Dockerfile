# syntax=docker/dockerfile:1
FROM node:26-trixie-slim

# bun installs the (root) dependencies; node runs the TypeScript sources.
COPY --from=oven/bun:1.4.1-slim /usr/local/bin/bun /usr/local/bin/bun

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg xdotool x11-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The lockfile is a workspace lock, so the ui manifest must be present even
# though this image never installs or runs the console.
COPY package.json bun.lock ./
COPY ui/package.json ./ui/package.json
RUN bun install --frozen-lockfile --production --filter .
COPY src ./src

USER node
ENV TZ=UTC
ENTRYPOINT ["node", "src/main.ts"]
