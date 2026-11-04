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
# descriptors and propagates the command's exit code. It also proves the
# two-way process boundary: the engine can kill agent-owned process groups on
# shell timeout and Stop, while the agent still cannot signal the engine
# (ADR-54 / #307). Exits non-zero on the first failed assertion, so it is
# scriptable.

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

# (f) Two-way process boundary (#307). ADR-22's uid split stops agent -> engine
# signals, but it also blocks the engine's own `process.kill(-pid)` from
# opencode's shell timeout/Stop path: the kernel answers EPERM and opencode
# waits for stdout until the command exits by itself. `opencode-entrypoint.sh`
# applies `cap_kill=ep` to the engine binary at container start (ADR-54); this
# section proves the running
# engine carries it, that it actually reaps agent-owned process groups on
# timeout and Stop (including the SIGTERM -> SIGKILL escalation), and that the
# reverse direction is still denied.
engine=$(readlink -f /usr/local/bin/opencode)
[ -e "$engine" ] || fail "opencode binary not found"
# The engine binary stays root-owned and non-writable so the engine's own
# write/edit tools cannot alter it; `opencode-entrypoint.sh` applies a file
# capability and a node read/execute ACL at container start (a build-time ACL is lost on image
# export). The engine's children lose the capability on exec, so the first
# `/api/shell` call (#308) and the agent never receive it.
[ "$("$STAT" -c '%U:%G' "$engine")" = "root:root" ] ||
  fail "engine binary must be owned by root:root, got $("$STAT" -c '%U:%G' "$engine")"
getfacl -c "$engine" 2>/dev/null | grep -q '^user:node:r-x' ||
  fail "engine binary is missing the node read/execute ACL"
getfacl -c "$engine" 2>/dev/null | grep -q '^mask::r-x' ||
  fail "engine binary ACL mask does not grant read/execute"
getfacl -c "$engine" 2>/dev/null | grep -q '^other::---' ||
  fail "engine binary ACL must not grant other users access"
engine_cap=$(su node -s /bin/sh -c "getcap '$engine'") || fail "cannot read the engine binary capabilities"
case "$engine_cap" in
  *"cap_kill=ep"*) ;;
  *) fail "engine binary is missing cap_kill=ep; rebuild and recreate the opencode image (ADR-54)" ;;
esac
[ "$(head -c 4 "$engine" | od -An -tx1 | tr -d ' \n')" = "7f454c46" ] ||
  fail "engine binary is not a native ELF launcher"
command -v setpriv >/dev/null || fail "setpriv is missing from the image"

engine_pid=
for proc in /proc/[0-9]*; do
  proc_pid=${proc#/proc/}
  proc_argv=$(tr '\0' '\n' < "$proc/cmdline" 2>/dev/null || true)
  proc_arg0=$(printf '%s\n' "$proc_argv" | sed -n '1p')
  proc_arg1=$(printf '%s\n' "$proc_argv" | sed -n '2p')
  [ "$(basename "$proc_arg0")" = "opencode" ] || continue
  [ "$proc_arg1" = "serve" ] || continue
  engine_pid=$proc_pid
  break
done
[ -n "$engine_pid" ] || fail "opencode serve process not found"
engine_uid=$(grep '^Uid:' "/proc/$engine_pid/status" | cut -f2)
[ "$engine_uid" = "1000" ] || fail "opencode serve must run as node (uid 1000), got $engine_uid"
engine_caps=$(grep '^CapEff:' "/proc/$engine_pid/status" | cut -f2)
engine_permitted=$(grep '^CapPrm:' "/proc/$engine_pid/status" | cut -f2)
engine_inheritable=$(grep '^CapInh:' "/proc/$engine_pid/status" | cut -f2)
engine_ambient=$(grep '^CapAmb:' "/proc/$engine_pid/status" | cut -f2)
[ "$engine_caps" = "0000000000000020" ] && [ "$engine_permitted" = "0000000000000020" ] ||
  fail "the running engine must have exactly CAP_KILL effective/permitted (CapEff=$engine_caps CapPrm=$engine_permitted)"
[ "$engine_inheritable" = "0000000000000000" ] && [ "$engine_ambient" = "0000000000000000" ] ||
  fail "the engine must not have an inheritable/ambient capability set (CapInh=$engine_inheritable CapAmb=$engine_ambient)"
engine_umask=$(grep '^Umask:' "/proc/$engine_pid/status" | cut -f2)
[ "$engine_umask" = "0002" ] || fail "engine umask must be 0002, got $engine_umask"

# The agent must not inherit the capability from the bounding set, execute/read
# the root-owned engine binary, or signal the engine.
agent_caps=$("$LAUNCHER" --exec "$SH" -c 'grep -E "^Cap(Prm|Eff|Amb):" /proc/self/status | cut -f2')
[ "$agent_caps" = "0000000000000000
0000000000000000
0000000000000000" ] || fail "the agent inherited capabilities (CapPrm/Eff/Amb: $agent_caps)"
if "$LAUNCHER" --exec "$SH" -c "test -x '$engine'"; then
  fail "the agent can execute the capped engine binary"
fi
if "$LAUNCHER" --exec "$SH" -c "cat '$engine' >/dev/null 2>&1"; then
  fail "the agent can read the capped engine binary"
fi
rc=0
"$LAUNCHER" -c "kill -0 $engine_pid" >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "the agent can signal the engine"

# The engine's HTTP shell route is the same service the shell tool uses. The
# first call after a location loads can race the config plugin and run as the
# engine uid; warm it up until the configured dropper is in effect, then refuse
# to test an unsandboxed shell.
BASE_URL=http://127.0.0.1:4096
LOCATION='location%5Bdirectory%5D=%2Fworkspace'
AUTH="${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD}"
cleanup_pids=
http_file=
cleanup() {
  for cleanup_pid in $cleanup_pids; do
    kill -s KILL -- "-$cleanup_pid" 2>/dev/null || true
  done
  if [ -n "$http_file" ]; then rm -f "$http_file"; fi
}
trap cleanup EXIT

json_field() {
  node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v[k];process.stdout.write(v===undefined?"":String(v))})' "$1"
}
api_get() { curl -fsS -u "$AUTH" "$BASE_URL$1"; }
api_post() { curl -fsS -u "$AUTH" -H 'content-type: application/json' -X POST "$BASE_URL$1" -d "$2"; }
api_delete() { curl -fsS -u "$AUTH" -X DELETE "$BASE_URL$1"; }

wait_shell_status() {
  wait_id=$1
  wait_want=$2
  wait_info=
  wait_status=
  wait_i=0
  while [ "$wait_i" -lt 20 ]; do
    wait_info=$(api_get "/api/shell/$wait_id?$LOCATION") || fail "cannot read shell $wait_id"
    wait_status=$(printf %s "$wait_info" | json_field data.status)
    if [ "$wait_status" = "$wait_want" ]; then
      printf %s "$wait_info"
      return 0
    fi
    wait_i=$((wait_i + 1))
    sleep 0.5
  done
  fail "shell $wait_id did not reach '$wait_want' (last status: ${wait_status:-unknown})"
}

# A process group is gone when no live member is left. Zombies do not count:
# without an init/reaper (a bare `docker run` drill) a killed child can stay in
# state Z until the container exits, and `kill(0)` would still find the group.
group_alive() {
  alive_pid=$1
  for proc in /proc/[0-9]*; do
    stat_line=$(cat "$proc/stat" 2>/dev/null) || continue
    rest=${stat_line##*) }
    set -- $rest
    [ "$#" -ge 3 ] || continue
    [ "$3" = "$alive_pid" ] || continue
    [ "$1" = "Z" ] && continue
    return 0
  done
  return 1
}

assert_group_gone() {
  gone_pid=$1
  gone_label=$2
  gone_i=0
  while [ "$gone_i" -lt 8 ]; do
    if ! group_alive "$gone_pid"; then
      return 0
    fi
    gone_i=$((gone_i + 1))
    sleep 0.5
  done
  fail "$gone_label process group $gone_pid survived"
}

configured=
warm_i=0
while [ "$warm_i" -lt 6 ]; do
  warm=$(api_post "/api/shell?$LOCATION" '{"command":"grep CapEff /proc/self/status","timeout":1000}') ||
    fail "could not create the shell config warm-up"
  warm_id=$(printf %s "$warm" | json_field data.id)
  configured=$(printf %s "$warm" | json_field data.shell)
  sleep 0.5
  warm_out=$(api_get "/api/shell/$warm_id/output?$LOCATION" | json_field data.output)
  case "$warm_out" in
    *0000000000000000*) ;;
    "") fail "warm-up shell output unavailable (shell=$configured)" ;;
    *) fail "a warm-up shell has a non-zero capability (shell=$configured, output=$warm_out)" ;;
  esac
  api_delete "/api/shell/$warm_id?$LOCATION" >/dev/null 2>&1 || true
  [ "$configured" = "$LAUNCHER" ] && break
  warm_i=$((warm_i + 1))
  sleep 0.5
done
[ "$configured" = "$LAUNCHER" ] ||
  fail "the shell config did not switch to $LAUNCHER (got '${configured:-none}'); refusing to test an unsandboxed shell"

# A 2 s timeout must kill the agent-owned process group and release the tool.
timeout_probe=$(api_post "/api/shell?$LOCATION" '{"command":"sleep 307","timeout":2000}') ||
  fail "could not create the timeout probe shell"
timeout_id=$(printf %s "$timeout_probe" | json_field data.id)
timeout_pid=$(printf %s "$timeout_probe" | json_field data.pid)
timeout_shell=$(printf %s "$timeout_probe" | json_field data.shell)
[ "$timeout_shell" = "$LAUNCHER" ] ||
  fail "timeout probe did not run through $LAUNCHER (got '$timeout_shell')"
case "$timeout_pid" in
  ''|0|1) fail "timeout probe has no usable pid (got '$timeout_pid')" ;;
esac
cleanup_pids="$cleanup_pids $timeout_pid"
wait_shell_status "$timeout_id" timeout >/dev/null
sleep 1
assert_group_gone "$timeout_pid" "timeout"
api_delete "/api/shell/$timeout_id?$LOCATION" >/dev/null 2>&1 || true

# A command that ignores SIGTERM must be escalated to SIGKILL (opencode's
# 3 s force-kill window) instead of surviving forever.
escalate_probe=$(api_post "/api/shell?$LOCATION" '{"command":"trap \"\" TERM; sleep 307","timeout":2000}') ||
  fail "could not create the SIGTERM probe shell"
escalate_id=$(printf %s "$escalate_probe" | json_field data.id)
escalate_pid=$(printf %s "$escalate_probe" | json_field data.pid)
case "$escalate_pid" in
  ''|0|1) fail "SIGTERM probe has no usable pid (got '$escalate_pid')" ;;
esac
cleanup_pids="$cleanup_pids $escalate_pid"
wait_shell_status "$escalate_id" timeout >/dev/null
sleep 6
assert_group_gone "$escalate_pid" "SIGTERM-ignoring timeout"
api_delete "/api/shell/$escalate_id?$LOCATION" >/dev/null 2>&1 || true

# Stop/interrupt (shell removal) must reap the whole foreground tree.
stop_probe=$(api_post "/api/shell?$LOCATION" '{"command":"sleep 307 & wait"}') ||
  fail "could not create the Stop probe shell"
stop_id=$(printf %s "$stop_probe" | json_field data.id)
stop_pid=$(printf %s "$stop_probe" | json_field data.pid)
case "$stop_pid" in
  ''|0|1) fail "Stop probe has no usable pid (got '$stop_pid')" ;;
esac
cleanup_pids="$cleanup_pids $stop_pid"
sleep 1
api_delete "/api/shell/$stop_id?$LOCATION" >/dev/null ||
  fail "could not remove the Stop probe shell"
assert_group_gone "$stop_pid" "Stop"

# A foreground server must free its port when the shell is stopped.
port_probe=$((3900 + ($$ % 90)))
http_file=$(mktemp /tmp/masterhand-drill-http.XXXXXX) ||
  fail "could not create the foreground-server probe file"
chmod 0644 "$http_file"
printf 'require("http").createServer((req,res)=>res.end("ok")).listen(%s,"127.0.0.1")\n' "$port_probe" > "$http_file"
server_body=$(printf '{"command":"node %s"}' "$http_file")
server_probe=$(api_post "/api/shell?$LOCATION" "$server_body") ||
  fail "could not create the foreground-server probe shell"
server_id=$(printf %s "$server_probe" | json_field data.id)
server_pid=$(printf %s "$server_probe" | json_field data.pid)
case "$server_pid" in
  ''|0|1) fail "foreground-server probe has no usable pid (got '$server_pid')" ;;
esac
cleanup_pids="$cleanup_pids $server_pid"
server_up=0
server_i=0
while [ "$server_i" -lt 20 ]; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$port_probe" >/dev/null 2>&1; then
    server_up=1
    break
  fi
  server_i=$((server_i + 1))
  sleep 0.25
done
[ "$server_up" = "1" ] || fail "the foreground HTTP server did not start on port $port_probe"
api_delete "/api/shell/$server_id?$LOCATION" >/dev/null ||
  fail "could not remove the foreground-server probe shell"
assert_group_gone "$server_pid" "foreground-server Stop"
if curl -fsS --max-time 1 "http://127.0.0.1:$port_probe" >/dev/null 2>&1; then
  fail "port $port_probe is still serving after Stop"
fi

# The BFF-managed run path stops through opencode's PTY API; it must reap the
# same tree.
pty_probe=$(curl -fsS -u "$AUTH" -H 'content-type: application/json' -X POST "$BASE_URL/api/pty?$LOCATION" \
  -d '{"command":"/usr/local/bin/agent-exec","args":["--exec","sh","-c","sleep 307 & wait"],"cwd":"/workspace"}') ||
  fail "could not create the PTY probe"
pty_id=$(printf %s "$pty_probe" | json_field data.id)
pty_pid=$(printf %s "$pty_probe" | json_field data.pid)
case "$pty_pid" in
  ''|0|1) fail "PTY probe has no usable pid (got '$pty_pid')" ;;
esac
cleanup_pids="$cleanup_pids $pty_pid"
sleep 1
api_delete "/api/pty/$pty_id?$LOCATION" >/dev/null ||
  fail "could not remove the PTY probe"
assert_group_gone "$pty_pid" "PTY Stop"

cleanup
trap - EXIT
echo "engine kill: timeout, SIGTERM escalation, Stop, PTY and port checks passed; agent cannot acquire the capability or signal the engine"

# (g) Agent toolbox. The tier is baked into the image as build metadata for this
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

echo "agent-exec drill: OK (uid 1001, gid 1000 only, env scrubbed, PORT allowlisted, fds closed, exit codes propagated, engine can kill agent groups on timeout/Stop, agent cannot acquire the capability or signal the engine, toolbox=${toolbox}/${browsers})"
