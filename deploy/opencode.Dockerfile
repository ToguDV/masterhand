# syntax=docker/dockerfile:1

# ---------- agent-exec (setuid privilege dropper) ----------
# Small static helper so the `node` user can start shell commands as `agent`.
# Built in its own stage so the dropper itself never drags a compiler into the
# runtime image (the optional toolbox in `standard|full` does install one).
FROM node:22-slim AS agent-exec
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY agent-exec.c /src/agent-exec.c
RUN gcc -O2 -Wall -Wextra -o /agent-exec /src/agent-exec.c

# ---------- runtime ----------
FROM node:22-slim

ARG OPENCODE_VERSION=2.0.6
ARG GH_VERSION=2.102.0
# Agent toolbox: minimal | standard | full (default). It only changes what is
# INSTALLED at build time; every shell still runs as `agent` (uid 1001) through
# agent-exec, and the toolbox never grants elevation. `standard` is the day-to-day
# dev set (compiler, Python, DB clients, CLI utils, pnpm/yarn); `full` adds ffmpeg
# and the Playwright browser runtime. See docs/runbooks/deployment.md.
ARG AGENT_TOOLBOX=full
# Bake a Playwright browser: auto (chromium when the toolbox is full) |
# chromium | none. Browsers land in the agent's HOME, which is where Playwright
# looks by default, so no runtime environment variable is needed.
ARG PLAYWRIGHT_BROWSERS=auto
# Pinned so the baked browser matches projects on the same Playwright version;
# a project on another version downloads its own into the same directory.
ARG PLAYWRIGHT_VERSION=1.64.1

# Base tools every deployment needs, independent of the toolbox. Kept in its own
# layer so bumping OPENCODE_VERSION does not reinstall them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Agent toolbox. `minimal` keeps the image as it was; unknown values fail the
# build instead of silently shipping a tier nobody asked for. Packages are
# root-owned and land on PATH for every user; the agent cannot add more at
# runtime because it has no elevation and /usr is not writable.
RUN set -eux; \
  case "${AGENT_TOOLBOX}" in \
    minimal) packages="" ;; \
    standard|full) \
      packages="python3 python3-venv python3-pip make g++ pkg-config \
        sqlite3 postgresql-client mariadb-client-core redis-tools \
        jq less file tree zip procps lsof netcat-openbsd bind9-dnsutils \
        iproute2 openssh-client git-lfs shellcheck"; \
      if [ "${AGENT_TOOLBOX}" = "full" ]; then packages="$packages ffmpeg"; fi ;; \
    *) echo "AGENT_TOOLBOX must be minimal|standard|full (got '${AGENT_TOOLBOX}')" >&2; exit 1 ;; \
  esac; \
  if [ -n "$packages" ]; then \
    apt-get update; \
    apt-get install -y --no-install-recommends $packages; \
    rm -rf /var/lib/apt/lists/*; \
    chmod u-s /usr/lib/openssh/ssh-keysign; \
    [ ! -u /usr/lib/openssh/ssh-keysign ]; \
    corepack enable; \
  fi

# `@opencode/cli` declares the glibc/musl and baseline variants for the same
# architecture as optional dependencies (~200 MB each). This image is Debian,
# so the musl builds can never run; prune them, prove the prune happened and
# smoke-test the CLI that remains.
RUN npm install -g @opencode/cli@${OPENCODE_VERSION} \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/*-musl \
  && [ -z "$(find /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode -maxdepth 1 -name '*-musl' -print -quit)" ] \
  && opencode --version \
  && rm -rf /root/.config /root/.cache /root/.local

# GitHub CLI for the agent shell (Settings > GitHub). Agents run through
# agent-exec with HOME=/home/agent, so gh reads the BFF-written hosts.yml.
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) gh_arch=amd64 ;; \
    arm64) gh_arch=arm64 ;; \
    *) echo "unsupported architecture for gh: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/gh.tar.gz \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"; \
  tar -xzf /tmp/gh.tar.gz -C /tmp; \
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
  rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${gh_arch}"

# Agent shell commands run as `agent` (uid 1001, primary group `node`), never as
# the `node` user (uid 1000) that runs `opencode serve`. Sharing the group keeps
# the workspace writable for both; the different uid means a broad kill from the
# shell cannot signal the engine (EPERM). See ARCHITECTURE.md ADR-22.
RUN useradd --uid 1001 --gid node --no-create-home --home-dir /home/agent --shell /bin/bash agent \
  && mkdir -p /home/agent \
  && chown -R agent:node /home/agent \
  && mkdir -p /home/agent/.config \
  && chown node:node /home/agent/.config \
  && chmod 755 /home/agent/.config

# Optional browser for end-to-end runs. `auto` follows the toolbox tier so a
# minimal image stays lean. Playwright looks under $HOME/.cache/ms-playwright
# and agent-exec sets HOME=/home/agent, so no environment variable is forwarded
# at runtime. The directory belongs to the agent uid because it is a normal
# image path (only ~/.config is a volume) and the agent may update or extend it.
# Dependencies are installed explicitly instead of with `--with-deps`: that flag
# pulls the Xvfb/Mesa/LLVM stack and a large font set (~200 MB) that a headless
# image does not need. `agent-exec-drill.sh` launches Chromium to prove the list
# is enough.
RUN set -eux; \
  install_browser=0; \
  case "${PLAYWRIGHT_BROWSERS}" in \
    auto) if [ "${AGENT_TOOLBOX}" = "full" ]; then install_browser=1; fi ;; \
    chromium) install_browser=1 ;; \
    none) ;; \
    *) echo "PLAYWRIGHT_BROWSERS must be auto|chromium|none (got '${PLAYWRIGHT_BROWSERS}')" >&2; exit 1 ;; \
  esac; \
  if [ "$install_browser" = "1" ]; then \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 \
      libfreetype6 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
      libx11-6 libx11-xcb1 libxcb1 libxcb-dri3-0 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxkbcommon0 libxrandr2 libegl1 libgles2 \
      libglvnd0 libglx0 fonts-liberation fonts-unifont; \
    rm -rf /var/lib/apt/lists/*; \
    npm install -g playwright@${PLAYWRIGHT_VERSION}; \
    PLAYWRIGHT_BROWSERS_PATH=/home/agent/.cache/ms-playwright \
      playwright install chromium; \
    npm cache clean --force; \
    chown -R agent:node /home/agent/.cache; \
  fi

# The config dir holds masterhand-providers.json; keep it owner-only at build
# time so a fresh named volume inherits 0700 (deployments with an existing
# volume are hardened by the CMD below).
RUN mkdir -p /workspace /home/node/.config/opencode /home/node/.local/share/opencode \
  && chown -R node:node /workspace /home/node/.config /home/node/.local \
  && chmod 2775 /workspace \
  && chmod 700 /home/node/.config/opencode

COPY --from=agent-exec /agent-exec /usr/local/bin/agent-exec
RUN chown root:root /usr/local/bin/agent-exec \
  && chmod 4755 /usr/local/bin/agent-exec

# Build metadata read by deploy/agent-exec-drill.sh. It lives after the layers
# that consume the toolbox args so changing a tier does not invalidate them;
# agent-exec clears the environment, so agent code never sees these values.
ENV AGENT_TOOLBOX=${AGENT_TOOLBOX} \
    PLAYWRIGHT_BROWSERS=${PLAYWRIGHT_BROWSERS} \
    PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}

USER node
WORKDIR /workspace

EXPOSE 4096
# umask 002 keeps everything opencode creates group-writable, so the agent can
# edit files made by the engine and vice versa.
#
# Harden the engine-owned paths at every start: named volumes are pre-existing
# in deployments, so a build-time chmod is not enough. The credential store
# (opencode.db; credentials moved there from auth.json in 2.0.6), its WAL
# sidecars and the engine log must not be readable/writable by the `agent` uid,
# and the config dir (which carries provider definitions) is owner-only. The
# BFF shares the config volume as `node`, so it can still write providers.
CMD ["sh", "-c", "set -e; umask 002; data=/home/node/.local/share/opencode; mkdir -p \"$data/log\"; chmod 700 \"$data/log\"; if [ ! -e \"$data/opencode.db\" ]; then : > \"$data/opencode.db\"; fi; chmod 600 \"$data/opencode.db\"; for f in \"$data/opencode.db-wal\" \"$data/opencode.db-shm\"; do if [ -e \"$f\" ]; then chmod 600 \"$f\"; fi; done; chmod 700 /home/node/.config/opencode; for f in \"$data/auth.json\" /home/node/.config/opencode/auth.json; do if [ -e \"$f\" ]; then chmod 600 \"$f\"; fi; done; exec opencode serve --hostname 0.0.0.0 --port 4096"]
