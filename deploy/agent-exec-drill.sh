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

# Commands passed to agent-exec are single-quoted on purpose: they must expand
# in the child shell (HOME, PORT, /proc are the child's), not in this script.
# shellcheck disable=SC2016
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

# (b2) Agent processes raise their OOM score so a runaway build is killed
# before the engine (which Compose keeps at a negative score).
oom=$("$LAUNCHER" --exec "$SH" -c 'cat /proc/self/oom_score_adj')
[ "$oom" = "500" ] || fail "expected oom_score_adj 500, got '$oom'"

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

# (f) Agent toolbox. The tier is baked into the image as build metadata for this
# drill only; agent-exec clears the environment, so agent code never sees it.
#
# Run this on a freshly created container: the agent can write
# `/home/agent/.local/bin` and its browser cache by design, so a container that
# already ran agent code could carry spoofed binaries. Tool probes below use a
# PATH without the agent-writable directory.
toolbox=${AGENT_TOOLBOX:-minimal}
browsers=${PLAYWRIGHT_BROWSERS:-none}
PATH_NO_AGENT=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

probe() {
  "$LAUNCHER" --exec "$SH" -c "PATH=$PATH_NO_AGENT $1"
}

# The pruned CLI (unused musl variants removed) must still start. It runs as the
# engine user: the agent cannot write the engine config dir by design.
su node -s /bin/sh -c 'opencode --version >/dev/null 2>&1' ||
  fail "opencode does not run after pruning unused platform binaries"

if [ "$toolbox" != "minimal" ]; then
  # Execute each tool, not just `command -v`: a broken library or a missing
  # runtime would otherwise pass.
  probe "python3 -V" >/dev/null || fail "python3 does not run as the agent"
  probe "make -v" >/dev/null || fail "make does not run as the agent"
  probe "g++ --version" >/dev/null || fail "g++ does not run as the agent"
  probe "psql --version" >/dev/null || fail "psql does not run as the agent"
  probe "sqlite3 :memory: 'select 1'" >/dev/null || fail "sqlite3 does not run as the agent"
  probe "redis-cli --version" >/dev/null || fail "redis-cli does not run as the agent"
  probe "jq -n 1" >/dev/null || fail "jq does not run as the agent"
  probe "less --version" >/dev/null || fail "less does not run as the agent"
  probe "file --version" >/dev/null || fail "file does not run as the agent"
  probe "tree --version" >/dev/null || fail "tree does not run as the agent"
  probe "zip -v" >/dev/null || fail "zip does not run as the agent"
  probe "lsof -p \$\$" >/dev/null || fail "lsof does not run as the agent"
  probe "git lfs version" >/dev/null || fail "git-lfs does not run as the agent"
  probe "shellcheck --version" >/dev/null || fail "shellcheck does not run as the agent"
  probe "test -x /usr/local/bin/pnpm" || fail "pnpm shim is missing (corepack)"
  probe "test -x /usr/local/bin/yarn" || fail "yarn shim is missing (corepack)"

  workdir=$("$LAUNCHER" --exec "$SH" -c 'd=$(mktemp -d /workspace/.toolbox-drill.XXXXXX); printf %s "$d"')
  [ -n "$workdir" ] || fail "could not create a workspace scratch dir as the agent"
  trap 'rm -rf "$workdir"' EXIT

  # Build something real: a venv and a compiled C++ binary.
  "$LAUNCHER" --exec "$SH" -c \
    "PATH=$PATH_NO_AGENT python3 -m venv '$workdir/venv' && '$workdir/venv/bin/python' -c 'import sys; print(sys.version)'" >/dev/null ||
    fail "python3 -m venv does not work as the agent"
  "$LAUNCHER" --exec "$SH" -c \
    "printf 'int main(){return 0;}' > '$workdir/probe.cpp' && PATH=$PATH_NO_AGENT g++ -O0 -o '$workdir/probe' '$workdir/probe.cpp' && '$workdir/probe'" ||
    fail "g++ cannot compile a C++ program as the agent"

  if [ "$toolbox" = "full" ]; then
    probe "ffmpeg -version" >/dev/null || fail "full toolbox is missing ffmpeg"
  fi
fi

# The browser depends on PLAYWRIGHT_BROWSERS, not on the tier: `minimal` +
# `chromium` is a documented combination.
if [ "$browsers" = "chromium" ] || { [ "$browsers" = "auto" ] && [ "$toolbox" = "full" ]; }; then
  chrome=$(probe 'find /home/agent/.cache/ms-playwright -type f -name chrome 2>/dev/null | head -1')
  [ -n "$chrome" ] || fail "baked Chromium not found under /home/agent/.cache/ms-playwright"
  version=$("$LAUNCHER" --exec "$chrome" --version 2>/dev/null)
  case "$version" in
    *Chromium*|*Chrome*) ;;
    *) fail "baked Chromium does not run (got '$version')" ;;
  esac
  # A real headless launch proves the explicit library list is enough.
  shot=$(probe 'playwright screenshot --browser=chromium about:blank /tmp/drill-chromium.png >/dev/null 2>&1 && printf ok; rm -f /tmp/drill-chromium.png')
  [ "$shot" = "ok" ] || fail "baked Chromium cannot take a screenshot (missing libraries?)"
fi

# No elevation, in every tier: no sudo, no container runtime, no unexpected
# setuid binary, and no writable system package path.
if probe 'command -v sudo' >/dev/null 2>&1; then fail "sudo is installed in the agent image"; fi
for runtime in docker podman nerdctl; do
  if probe "command -v $runtime" >/dev/null 2>&1; then fail "$runtime is installed in the agent image"; fi
done
[ ! -u /usr/lib/openssh/ssh-keysign ] || fail "ssh-keysign kept its setuid bit"
global_prefix=$(npm prefix -g)
if "$LAUNCHER" --exec "$SH" -c "test -w '$global_prefix'"; then
  fail "the agent can write to the global npm prefix ($global_prefix)"
fi
if probe 'test -w /usr/local/bin'; then fail "the agent can write to /usr/local/bin"; fi

echo "agent-exec drill: OK (uid 1001, gid 1000 only, env scrubbed, PORT allowlisted, fds closed, exit codes propagated, toolbox=${toolbox}/${browsers})"
