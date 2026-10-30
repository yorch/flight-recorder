# syntax=docker/dockerfile:1
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends squid jq \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o proxy -g proxy /var/log/squid-pair \
    && chown -R proxy:proxy /etc/squid /var/log/squid /var/spool/squid /run

COPY --chmod=0755 gen-squid-conf /usr/local/bin/

USER proxy
ENTRYPOINT ["/usr/local/bin/gen-squid-conf"]
