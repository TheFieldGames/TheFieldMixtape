FROM node:20-slim

# ffmpeg for mp3->ogg conversion, git for the clone/commit/push flow,
# curl+ca-certificates to fetch the pinned tcli release below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      git \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Pinned tcli release (see plan: every release upstream is flagged
# prerelease, so GitHub's /releases/latest API 404s — never use a "latest"
# lookup here, always a hardcoded version + direct asset URL). Self-contained
# binary, no .NET runtime needed — verified during pre-flight that it only
# depends on standard libs already present in this base image.
RUN curl -fsSL -o /tmp/tcli.tar.gz \
      https://github.com/thunderstore-io/thunderstore-cli/releases/download/0.2.4/tcli-0.2.4-linux-x64.tar.gz \
    && tar -xzf /tmp/tcli.tar.gz -C /tmp \
    && mv /tmp/tcli-0.2.4-linux-x64/tcli /usr/local/bin/tcli \
    && chmod +x /usr/local/bin/tcli \
    && rm -rf /tmp/tcli.tar.gz /tmp/tcli-0.2.4-linux-x64

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV TCLI_PATH=/usr/local/bin/tcli

EXPOSE 3000

CMD ["node", "server.js"]
