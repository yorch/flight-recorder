FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      squid jq \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/squid-pair \
    && chown -R proxy:proxy /etc/squid /var/log/squid /var/spool/squid /var/log/squid-pair /run

COPY --chmod=0755 gen-squid-conf /usr/local/bin/

USER proxy
ENTRYPOINT ["/usr/local/bin/gen-squid-conf"]
