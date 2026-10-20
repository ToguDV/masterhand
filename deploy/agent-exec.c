/*
 * agent-exec — drop privileges to the unprivileged `agent` user and exec a command.
 *
 * `opencode serve` runs as the `node` user; agent shell commands must run as a
 * different uid so a broad kill (`pkill node`, `killall`, ...) cannot signal
 * the engine. A non-root process cannot change uid on its own, so this tiny
 * helper is installed setuid-root (mode 4755). The target uid/gid are
 * hardcoded: it can never grant root or any other identity. This is the
 * process boundary behind `ARCHITECTURE.md` ADR-22 (and the storage/runtime
 * half of ADR-37: credentials the engine holds must not leak into agent code).
 *
 * Invocations:
 *   agent-exec -c <command>           opencode's `shell` setting: execs bash.
 *   agent-exec --exec <cmd> [args...] managed runs (BFF `MANAGED_RUN_LAUNCHER`):
 *                                     execvp(cmd, args) verbatim, no shell.
 *
 * Environment contract: the inherited environment is discarded, never
 * forwarded. `OPENCODE_*`, provider keys, `NODE_OPTIONS`, `LD_*`, `GIT_*`,
 * `SSH_AUTH_SOCK`, `MASTERHAND_*` and everything else disappear. The child
 * gets exactly:
 *   PATH    /home/agent/.local/bin plus the system directories
 *   HOME    /home/agent            USER/LOGNAME  agent
 *   SHELL   /bin/bash              TMPDIR        /tmp
 *   TERM    inherited, else xterm-256color
 *   LANG    inherited, else C.UTF-8
 *   PORT    inherited only when it is a valid numeric port (1-65535)
 *
 * Build (see deploy/opencode.Dockerfile): gcc -O2 -Wall -Wextra agent-exec.c
 * Runtime drill: deploy/agent-exec-drill.sh (inside the opencode container).
 */
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define AGENT_UID 1001
#define AGENT_GID 1000 /* the `node` group: the shared workspace is group-writable */
#define AGENT_HOME "/home/agent"
#define SAFE_PATH "/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
#define EXEC_COMMAND_MISSING 127

/** Copies a non-empty inherited value so it survives `clearenv()`. */
static char *duplicate_env(const char *name) {
  const char *value = getenv(name);
  if (!value || !*value) return NULL;
  char *copy = strdup(value);
  if (!copy) {
    perror("agent-exec: strdup");
    exit(1);
  }
  return copy;
}

/** Strict decimal port check: digits only, 1..65535 (no sign, spaces or hex). */
static int valid_port(const char *value) {
  if (!value || !*value) return 0;
  long port = 0;
  for (const char *cursor = value; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9') return 0;
    port = port * 10 + (*cursor - '0');
    if (port > 65535) return 0;
  }
  return port >= 1;
}

static void set_env(const char *name, const char *value) {
  if (setenv(name, value, 1) != 0) {
    perror("agent-exec: setenv");
    exit(1);
  }
}

/**
 * Only stdio survives the exec. The engine may hold the credential DB, logs or
 * sockets without CLOEXEC; an agent child must not inherit those descriptors
 * (and read them through /proc/self/fd). `close_range` is the fast path and
 * the loop is the portable fallback for older kernels.
 */
static void close_inherited_fds(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) return;
#endif
  long limit = sysconf(_SC_OPEN_MAX);
  if (limit < 0 || limit > 65536) limit = 65536;
  for (int fd = 3; fd < limit; fd++) close(fd);
}

int main(int argc, char **argv) {
  const int exec_mode = argc > 1 && strcmp(argv[1], "--exec") == 0;
  if (exec_mode && (argc < 3 || argv[2][0] == '\0')) {
    fprintf(stderr, "agent-exec: --exec requires a non-empty command\n");
    return EXEC_COMMAND_MISSING;
  }

  /* Read the few forwarded values before the environment is wiped. */
  char *term = duplicate_env("TERM");
  char *lang = duplicate_env("LANG");
  char *port = NULL;
  const char *inherited_port = getenv("PORT");
  if (inherited_port && valid_port(inherited_port)) {
    port = strdup(inherited_port);
    if (!port) {
      perror("agent-exec: strdup");
      return 1;
    }
  }

  /* Drop every supplementary group first: the agent must not inherit node's. */
  if (setgroups(0, NULL) != 0) {
    perror("agent-exec: setgroups");
    return 1;
  }
  if (setgid(AGENT_GID) != 0) {
    perror("agent-exec: setgid");
    return 1;
  }
  if (setuid(AGENT_UID) != 0) {
    perror("agent-exec: setuid");
    return 1;
  }
  umask(002);

  /* Minimal allowlist: nothing the engine inherited reaches agent code. */
  if (clearenv() != 0) {
    perror("agent-exec: clearenv");
    return 1;
  }
  set_env("PATH", SAFE_PATH);
  set_env("HOME", AGENT_HOME);
  set_env("USER", "agent");
  set_env("LOGNAME", "agent");
  set_env("SHELL", "/bin/bash");
  set_env("TERM", term ? term : "xterm-256color");
  set_env("LANG", lang ? lang : "C.UTF-8");
  set_env("TMPDIR", "/tmp");
  if (port) set_env("PORT", port);
  free(term);
  free(lang);
  free(port);
  close_inherited_fds();

  if (exec_mode) {
    /* argv verbatim: no shell to reinterpret metacharacters. argv[2] is the
     * executable; the rest (including argv[argc] == NULL) is its argv. */
    execvp(argv[2], &argv[2]);
    perror("agent-exec: execvp");
    return EXEC_COMMAND_MISSING;
  }

  /* opencode invokes `shell -c <command>`: argv[0] becomes bash, the rest are
   * bash's own arguments. */
  char **bash_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (!bash_argv) return 1;
  bash_argv[0] = "/bin/bash";
  for (int i = 1; i < argc; i++) bash_argv[i] = argv[i];

  execv("/bin/bash", bash_argv);
  perror("agent-exec: execv");
  return 127;
}
