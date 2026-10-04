/*
 * agent-exec — drop privileges to the unprivileged `agent` user and exec bash.
 *
 * `opencode serve` runs as the `node` user; agent shell commands must run as a
 * different uid so a broad kill (`pkill node`, `killall`, ...) cannot signal
 * the engine. A non-root process cannot change uid on its own, so this tiny
 * helper is installed setuid-root (mode 4755). The target uid/gid are
 * hardcoded and it only ever execs bash: it can never grant root or any other
 * identity. It is the process boundary behind `ARCHITECTURE.md` ADR-22.
 *
 * Build (see deploy/opencode.Dockerfile): gcc -O2 -Wall -Wextra agent-exec.c
 */
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define AGENT_UID 1001
#define AGENT_GID 1000 /* the `node` group: the shared workspace is group-writable */
#define AGENT_HOME "/home/agent"

int main(int argc, char **argv) {
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

  setenv("HOME", AGENT_HOME, 1);
  setenv("USER", "agent", 1);
  setenv("LOGNAME", "agent", 1);
  setenv("SHELL", "/bin/bash", 1);

  /* Pass every argument through: opencode invokes `shell -c <command>`.
   * `argv[0]` becomes bash, the rest are bash's own arguments. */
  char **bash_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (!bash_argv) return 1;
  bash_argv[0] = "/bin/bash";
  for (int i = 1; i < argc; i++) bash_argv[i] = argv[i];

  execv("/bin/bash", bash_argv);
  perror("agent-exec: execv");
  return 127;
}
