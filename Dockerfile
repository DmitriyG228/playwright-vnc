FROM mcr.microsoft.com/playwright:v1.50.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb fluxbox x11vnc websockify novnc socat curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm init -y && npm install playwright@1.50.0

ENV DISPLAY=:99
EXPOSE 6080 9222

COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
