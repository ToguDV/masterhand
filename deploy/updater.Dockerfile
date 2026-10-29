# syntax=docker/dockerfile:1
#
# Opt-in updater sidecar (#134). It is the only container with the Docker
# socket; the BFF talks to it over the internal network with a shared token.
# The image is published by the release workflow as
# `ghcr.io/togudv/masterhand-updater:<version>`.
FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY updater/updater.mjs ./updater.mjs

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "updater.mjs"]
