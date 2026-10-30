# syntax=docker/dockerfile:1
FROM node:26-trixie-slim
WORKDIR /site
COPY server.mjs .
EXPOSE 80
ENTRYPOINT ["node", "server.mjs"]
