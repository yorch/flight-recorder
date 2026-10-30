FROM node:26-trixie-slim

USER node
WORKDIR /app
COPY --chown=node:node server.mjs .
ENV LOG_FILE=/log/internet.jsonl
ENTRYPOINT ["node", "server.mjs"]
