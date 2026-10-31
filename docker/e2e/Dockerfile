# syntax=docker/dockerfile:1
# Playwright e2e driver for criterion 29 (§16.4). Build context is the repo root.
# The image ships the browsers for exactly playwright 1.64.1; we only need the library.
FROM mcr.microsoft.com/playwright:v1.64.1-resolute

WORKDIR /e2e
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm init -y >/dev/null && npm install playwright@1.64.1

COPY tests/acceptance/tools/ui-e2e.mjs ./ui-e2e.mjs

USER pwuser
ENTRYPOINT ["node", "/e2e/ui-e2e.mjs"]
