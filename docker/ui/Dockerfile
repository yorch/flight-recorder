# syntax=docker/dockerfile:1
# Control-plane API + SPA host (§16.2). Build context is the repo root.

# Stage 1: build the React SPA (§16.3) — no host ui/dist required.
FROM node:26-trixie-slim AS uibuild
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# Stage 2: control-plane server (node runs the TypeScript sources directly).
FROM node:26-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=uibuild /ui/dist ./ui/dist

USER node
ENV TZ=UTC
ENTRYPOINT ["node", "src/server/index.ts"]
