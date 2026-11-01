#!/bin/sh
# E2E stand-in for the cloudflared binary: answers --version and, for a quick
# tunnel, prints a fake trycloudflare URL and stays alive until killed.
# Creating the file in E2E_CLOUDFLARED_DIE_FILE makes it exit on its own, which
# simulates a tunnel that dies while running (#89).
if [ "$1" = "--version" ]; then
  echo "cloudflared version 0.0.0-e2e"
  exit 0
fi

# Each fake process announces its own hostname: $$ is unique per process, so a
# Stop -> Start never reuses the previous URL. Specs match this shape (see
# E2E_TUNNEL_URL in tests/helpers.ts) and assert the src/Open link/text, never
# that the iframe loads: the host is not real.
echo "Your quick Tunnel has been created! Visit it at https://e2e-preview-$$.trycloudflare.com" >&2
while true; do
  if [ -n "$E2E_CLOUDFLARED_DIE_FILE" ] && [ -f "$E2E_CLOUDFLARED_DIE_FILE" ]; then
    exit 1
  fi
  sleep 0.2
done
