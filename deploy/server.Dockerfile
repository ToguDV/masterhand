# syntax=docker/dockerfile:1

# ---------- toolchain ----------
# Runtime tooling shared by the development and production images, so both run
# the same `git`/`gh`/`cloudflared` commands. Kept separate from the build
# stages so neither shipped image carries a compiler.
#
# cloudflared powers session previews (Cloudflare quick tunnels). Pin the
# version; override CLOUDFLARED_VERSION at build time to upgrade.
FROM node:22-slim AS toolchain
ARG CLOUDFLARED_VERSION=2026.9.3
RUN apt-get update \
  && apt-get install -y --no-install-recommends git gh ca-certificates curl \
  && curl -fsSL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-$(dpkg --print-architecture)" \
  && chmod +x /usr/local/bin/cloudflared \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown node:node /data \
  # The bind-mounted workspace may be owned by a different host uid; git would
  # otherwise refuse to operate on it ("dubious ownership").
  && git config --system --add safe.directory '*'

# ---------- base ----------
# Dependencies for the BFF and the web build, including dev dependencies so the
# `dev` target can run the watchers. Production prunes them later.
FROM toolchain AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
COPY packages/client-core/package.json packages/client-core/
COPY e2e/package.json e2e/
# Install only what the BFF and the web build need (skips Electron/Expo/Playwright).
RUN npm ci --no-audit --no-fund -w @masterhand/server -w @masterhand/web

# ---------- dev ----------
# Hot-reloading development stack. The topology is identical to production
# (same base image, network, paths, env contract and cloudflared tooling); the
# sources are bind-mounted by deploy/docker-compose.dev.yml and `scripts/dev.mjs`
# runs the BFF watcher plus Vite.
FROM base AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages/client-core packages/client-core
COPY apps/server apps/server
COPY apps/web apps/web
COPY scripts scripts
# Run as the same unprivileged user as production (`node`, uid 1000): workspace
# files stay group-writable for the agent (shared `node` group + umask 002) and
# Vite can write its cache under the installed dependencies.
RUN chown -R node:node /app
USER node
EXPOSE 8787 5173
CMD ["sh", "-c", "umask 002; exec node scripts/dev.mjs web --host 0.0.0.0"]

# ---------- build ----------
FROM base AS build
COPY tsconfig.base.json ./
COPY packages/client-core packages/client-core
COPY apps/server apps/server
COPY apps/web apps/web

RUN npm run build -w @masterhand/web \
  && npm run build -w @masterhand/server

# Drop the build-only dependencies before they reach the runtime image.
FROM build AS prod-deps
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM toolchain AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/data
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/apps/server/package.json ./apps/server/package.json
COPY --from=prod-deps /app/apps/server/dist ./apps/server/dist
COPY --from=prod-deps /app/apps/web/dist ./apps/web/dist

USER node
EXPOSE 8787
# umask 002 keeps workspace folders and worktrees group-writable, so the agent
# (same group, different uid) can write what the BFF creates and vice versa.
CMD ["sh", "-c", "umask 002; exec node apps/server/dist/index.js"]
