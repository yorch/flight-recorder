# syntax=docker/dockerfile:1
# Playwright e2e driver for criteria 29/32 (§16.4). Build context is the repo root.
# The image ships the browsers for exactly playwright 1.64.1; we only need the library.
FROM mcr.microsoft.com/playwright:v1.64.1-resolute

# bun installs the driver dependency; node runs the e2e scripts.
COPY --from=oven/bun:1.4.1-slim /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /e2e
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# No manifest in this context: bun creates one and keeps the pin exact.
RUN bun add --exact playwright@1.64.1

COPY tests/acceptance/tools/ui-e2e.mjs ./ui-e2e.mjs
COPY tests/acceptance/tools/live-progress-e2e.mjs ./live-progress-e2e.mjs

USER pwuser
ENTRYPOINT ["node", "/e2e/ui-e2e.mjs"]
