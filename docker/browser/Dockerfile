# syntax=docker/dockerfile:1
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xvfb x11-utils openbox supervisor \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Google publishes google-chrome-stable for both amd64 and arm64 in this repository
# hadolint ignore=DL3008,DL4006
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# /tmp/.X11-unix is pre-created so the shared named volume inherits the sticky, world-writable mode
RUN useradd -m -s /bin/bash automation \
    && install -d -m 1777 /tmp/.X11-unix

COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY --chmod=0755 wait-for-x start-chrome /usr/local/bin/

USER automation
ENV DISPLAY=:99 SCREEN_WIDTH=1920 SCREEN_HEIGHT=1080 TZ=UTC CHROME_LANG=en-US CHROME_WEBGL=0

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
