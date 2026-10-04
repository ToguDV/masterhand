# syntax=docker/dockerfile:1

# ---------- agent-exec (setuid privilege dropper) ----------
# Small static helper so the `node` user can start shell commands as `agent`.
# Built in its own stage; the runtime image never ships a compiler.
FROM node:22-slim AS agent-exec
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY agent-exec.c /src/agent-exec.c
RUN gcc -O2 -Wall -Wextra -o /agent-exec /src/agent-exec.c

# ---------- runtime ----------
FROM node:22-slim

ARG OPENCODE_VERSION=2.0.6

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep unzip xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @opencode/cli@${OPENCODE_VERSION} \
  && npm cache clean --force

# Agent shell commands run as `agent` (uid 1001, primary group `node`), never as
# the `node` user (uid 1000) that runs `opencode serve`. Sharing the group keeps
# the workspace writable for both; the different uid means a broad kill from the
# shell cannot signal the engine (EPERM). See ARCHITECTURE.md ADR-22.
RUN useradd --uid 1001 --gid node --no-create-home --home-dir /home/agent --shell /bin/bash agent \
  && mkdir -p /home/agent \
  && chown -R agent:node /home/agent

RUN mkdir -p /workspace /home/node/.config/opencode /home/node/.local/share/opencode \
  && chown -R node:node /workspace /home/node/.config /home/node/.local \
  && chmod 2775 /workspace

COPY --from=agent-exec /agent-exec /usr/local/bin/agent-exec
RUN chown root:root /usr/local/bin/agent-exec \
  && chmod 4755 /usr/local/bin/agent-exec

USER node
WORKDIR /workspace

EXPOSE 4096
# umask 002 keeps everything opencode creates group-writable, so the agent can
# edit files made by the engine and vice versa.
CMD ["sh", "-c", "umask 002; exec opencode serve --hostname 0.0.0.0 --port 4096"]
