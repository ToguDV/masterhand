#!/bin/sh
# Runtime drill for the setuid `agent-exec` helper (ADR-22 / ADR-37).
#
# Run INSIDE the opencode container as root, after `agent-exec.c` or the image
# changes (it is deliberately not part of the Node test gates):
#
#   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
#     exec -T --user root opencode sh -s < deploy/agent-exec-drill.sh
#
# It proves what the unit tests cannot: the real setuid binary drops to uid
# 1001 with no supplementary groups, scrubs the engine environment
# (OPENCODE_SERVER_PASSWORD), preserves a valid PORT, closes inherited file
# descriptors and propagates the command's exit code. Exits non-zero on the
# first failed assertion, so it is scriptable.

set -eu

LAUNCHER=/usr/local/bin/agent-exec
ID=/usr/bin/id
PRINTENV=/usr/bin/printenv
STAT=/usr/bin/stat
SH=/bin/sh

fail() {
  echo "agent-exec drill: FAIL: $*" >&2
  exit 1
}

[ -x "$LAUNCHER" ] || fail "$LAUNCHER is missing or not executable"
[ -u "$LAUNCHER" ] || fail "$LAUNCHER is not setuid"
[ "$("$STAT" -c '%a' "$LAUNCHER")" = "4755" ] || fail "$LAUNCHER must be mode 4755"
[ "$("$ID" -u)" = "0" ] || fail "run this drill as root (docker compose exec --user root)"

# (a) The child runs as the unprivileged agent uid, through `--exec` and
# through the shell setting path (`agent-exec -c ...`). Supplementary groups
# must be empty (primary gid 1000 only).
uid=$("$LAUNCHER" --exec "$ID" -u)
[ "$uid" = "1001" ] || fail "expected --exec uid 1001, got $uid"
uid=$("$LAUNCHER" -c "$ID -u")
[ "$uid" = "1001" ] || fail "expected -c uid 1001, got $uid"
groups=$("$LAUNCHER" --exec "$ID" -G)
[ "$groups" = "1000" ] || fail "expected only gid 1000, got '$groups'"

# (b) The engine password must not survive into the child environment. Only
# meaningful when the container actually has it set.
[ -n "${OPENCODE_SERVER_PASSWORD:-}" ] || fail "OPENCODE_SERVER_PASSWORD is unset; cannot prove scrubbing"
"$LAUNCHER" --exec "$SH" -c 'test -z "${OPENCODE_SERVER_PASSWORD:-}"' ||
  fail "OPENCODE_SERVER_PASSWORD reached the child environment"
if "$LAUNCHER" --exec "$PRINTENV" OPENCODE_SERVER_PASSWORD >/dev/null 2>&1; then
  fail "printenv found OPENCODE_SERVER_PASSWORD in the child environment"
fi

# (c) A valid PORT is preserved; an invalid one is dropped.
port=$(PORT=3210 "$LAUNCHER" --exec "$SH" -c 'printf %s "${PORT:-}"')
[ "$port" = "3210" ] || fail "expected PORT=3210 to survive, got '$port'"
port=$(PORT=not-a-port "$LAUNCHER" --exec "$SH" -c 'printf %s "${PORT:-}"')
[ -z "$port" ] || fail "invalid PORT should be dropped, got '$port'"

# (d) No descriptor above stdio survives the exec (the engine may hold the
# credential DB or sockets without CLOEXEC). The shell glob may include its
# own directory fd (3) while expanding `/proc/self/fd/*`; close it explicitly
# so the assertion is about the inherited set.
fds=$("$LAUNCHER" --exec "$SH" -c 'for f in /proc/self/fd/*; do fd=${f##*/}; [ "$fd" = "3" ] && exec 3>&- 2>/dev/null || true; printf "%s\n" "$fd"; done' 2>/dev/null | sort -n | tr '\n' ' ')
case "$fds" in
  "0 1 2 " | "0 1 2 3 ") ;;
  *) fail "unexpected inherited descriptors: $fds" ;;
esac

# (e) The command's exit code propagates verbatim (127 is exec failure only).
rc=0
"$LAUNCHER" --exec "$SH" -c 'exit 7' || rc=$?
[ "$rc" = "7" ] || fail "expected exit code 7, got $rc"

# A missing --exec command is rejected with a clear error before exec.
rc=0
"$LAUNCHER" --exec >/dev/null 2>&1 || rc=$?
[ "$rc" = "127" ] || fail "expected 127 for a missing --exec command, got $rc"

echo "agent-exec drill: OK (uid 1001, gid 1000 only, env scrubbed, PORT allowlisted, fds closed, exit codes propagated)"
