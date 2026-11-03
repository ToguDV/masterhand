# syntax=docker/dockerfile:1
#
# Resilience supervisor sidecar. It is the only container besides the opt-in
# updater with the Docker socket; it can only restart/stop the two Compose
# services resolved by label, never arbitrary containers or host paths.
FROM node:22-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY watchdog/watchdog.mjs ./watchdog.mjs

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "watchdog.mjs"]
