#!/bin/sh
# E2E stand-in for the cloudflared binary: answers --version and, for a quick
# tunnel, prints a fake trycloudflare URL and stays alive until killed.
# Creating the file in E2E_CLOUDFLARED_DIE_FILE makes it exit on its own, which
# simulates a tunnel that dies while running (#89).
if [ "$1" = "--version" ]; then
  echo "cloudflared version 0.0.0-e2e"
  exit 0
fi

echo "Your quick Tunnel has been created! Visit it at https://e2e-preview.trycloudflare.com" >&2
while true; do
  if [ -n "$E2E_CLOUDFLARED_DIE_FILE" ] && [ -f "$E2E_CLOUDFLARED_DIE_FILE" ]; then
    exit 1
  fi
  sleep 0.2
done
