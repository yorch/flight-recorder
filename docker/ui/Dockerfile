# syntax=docker/dockerfile:1
# Control-plane API + SPA host (§16.2). Build context is the repo root.

# Stage 1: build the React SPA (§16.3) — no host ui/dist required.
FROM node:26-trixie-slim AS uibuild
COPY --from=oven/bun:1.4.1-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY ui/package.json ./ui/package.json
RUN bun install --frozen-lockfile
COPY ui ./ui
RUN bun run --cwd ui build

# Stage 2: control-plane server (node runs the TypeScript sources directly).
FROM node:26-trixie-slim
COPY --from=oven/bun:1.4.1-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY ui/package.json ./ui/package.json
RUN bun install --frozen-lockfile --production --filter .
COPY src ./src
COPY --from=uibuild /app/ui/dist ./ui/dist

USER node
ENV TZ=UTC
ENTRYPOINT ["node", "src/server/index.ts"]
