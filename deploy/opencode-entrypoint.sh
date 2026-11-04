#!/bin/sh
# opencode entrypoint: give the engine CAP_KILL as a file capability, then drop.
#
# ADR-54 / #307: ADR-22 runs agent shells/PTYs as `agent` (uid 1001), so the
# engine (`node`, uid 1000) needs CAP_KILL to terminate their process groups on
# shell timeout and Stop. A Compose `cap_add` alone is not enough: the container
# user is non-root and Docker leaves its effective set empty. The capability is
# a file capability on the engine binary, applied here at container start: a
# build-time POSIX ACL does not survive the Docker image export (verified), and
# a node-owned binary would be writable by the engine's own write/edit tools.
# The binary is root-owned `0700` (the ACL mask makes the effective mode 750),
# the ACL gives `node` only read/execute, and the file capability is effective
# only for the engine's own exec. The engine's
# non-setuid children (including the first `/api/shell` call in a fresh
# location, #308) lose the capability on exec; the setuid `agent-exec` dropper
# drops every capability before exec'ing the agent. Agent code can neither
# read/execute the binary nor acquire the capability, so agent→engine stays
# `EPERM`.
#
# The entrypoint starts as root only for this setup and the engine-path
# hardening, then drops to `node`. Compose keeps `KILL` (the capability's
# bounding-set prerequisite) and `SETFCAP` (setcap) plus `SETUID`/`SETGID` (the
# setuid dropper). Never add no-new-privileges: it disables the file capability
# and the setuid dropper.
set -eu

# `setpriv` keeps the caller's environment; the node base image's HOME is /root.
# The engine and the hardening use the node home so opencode writes its data to
# /home/node (the volume the image and the BFF expect).
HOME=/home/node
export HOME

# Run a debugging/auth command as the same unprivileged runtime user the image
# used to select, without touching the engine file capability. The old CMD was
# overridable, so `docker compose run opencode opencode auth login` must keep
# working; the next engine start hardens the data directory.
if [ "$#" -gt 0 ]; then
  exec setpriv --reuid=node --regid=node --init-groups sh -c 'umask 002; exec "$@"' sh "$@"
fi

engine="$(readlink -f /usr/local/bin/opencode)"
chown root:root "$engine"
chmod 0700 "$engine"
setfacl -m u:node:rx "$engine"
setcap cap_kill=ep "$engine"
getcap "$engine" | grep -q 'cap_kill=ep'
getfacl -c "$engine" 2>/dev/null | grep -q '^user:node:r-x'
getfacl -c "$engine" 2>/dev/null | grep -q '^mask::r-x'
getfacl -c "$engine" 2>/dev/null | grep -q '^other::---'
[ "$(head -c 4 "$engine" | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]
su node -s /bin/sh -c 'opencode --version >/dev/null'

# Keep the engine-owned paths owner-only at every start: named volumes are
# pre-existing in deployments, so a build-time chmod is not enough. The
# credential store (opencode.db; credentials moved there from auth.json in
# 2.0.6), its WAL sidecars and the engine log must not be readable/writable by
# the `agent` uid, and the config dir (which carries provider definitions) is
# owner-only. The BFF shares the config volume as `node`, so it can still write
# providers.
setpriv --reuid=node --regid=node --init-groups sh -c '
  set -e
  umask 002
  data=/home/node/.local/share/opencode
  mkdir -p "$data/log"
  chmod 700 "$data/log"
  if [ ! -e "$data/opencode.db" ]; then : > "$data/opencode.db"; fi
  chmod 600 "$data/opencode.db"
  for f in "$data/opencode.db-wal" "$data/opencode.db-shm"; do
    if [ -e "$f" ]; then chmod 600 "$f"; fi
  done
  chmod 700 /home/node/.config/opencode
  for f in "$data/auth.json" /home/node/.config/opencode/auth.json; do
    if [ -e "$f" ]; then chmod 600 "$f"; fi
  done
'

# `umask 002` keeps everything opencode creates group-writable, so the agent can
# edit files made by the engine and vice versa. The file capability on the
# engine binary is effective for this exec; the engine's children lose it.
exec setpriv --reuid=node --regid=node --init-groups \
  sh -c 'umask 002; exec opencode serve --hostname 0.0.0.0 --port 4096'
