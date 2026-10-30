FROM mcr.microsoft.com/playwright:v1.64.1-resolute

USER root
RUN mkdir -p /srv/pw \
    && cd /srv/pw \
    && npm init -y >/dev/null \
    && npm install playwright-core@1.64.1 --omit=dev --no-audit --no-fund \
    && chown -R pwuser:pwuser /srv/pw

USER pwuser
ENTRYPOINT ["node", "/srv/pw/node_modules/playwright-core/cli.js", "run-server", "--port", "3000", "--host", "0.0.0.0", "--unsafe"]
