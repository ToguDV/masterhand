# Runbook — Resilience (supervisor, restarts and recovery)

MasterHand runs two long-lived services: `masterhand` (BFF + SQLite) and
`opencode` (agent engine). Docker's `restart: unless-stopped` only covers a
process that **exits**: it never restarts a container that is running but
unhealthy, wedged or OOM-thrashing, and it has no budget. The resilience layer
adds a first-party supervisor and a recovery pass on top of that.

## 1. What the supervisor does

`deploy/watchdog` is an always-on sidecar and the only container (besides the
opt-in updater) with the Docker socket. It resolves `masterhand` and `opencode`
by Compose labels and can only restart/stop/start those two services — it has
no host paths, no arbitrary commands and no published ports.

Every ~10 s it reads each service's health, memory, exit state and restart
count. It restarts a service when:

- the container exited with OOM/SIGKILL or a non-zero code;
- the healthcheck stays `unhealthy` for 2 consecutive samples;
- Docker's own restart policy brought it back after a crash (counted, not
  bounced twice).

A slow boot is never judged: the healthcheck's `start_period` (60 s for
opencode) plus `WATCHDOG_STARTUP_GRACE_MS` (180 s default) cover it. Memory at
≥95 % for 60 s is reported as a warning, not a restart: killing a healthy build
is worse than letting it finish.

### The restart budget

1. First failure → attempt 1, restart.
2. Failure before 5 minutes of continuous health → attempt 2, restart.
3. Another fast failure → attempt 3, restart.
4. Another fast failure → **circuit open**: no more restarts; the service is
   stopped (`docker stop`) so `unless-stopped` does not resurrect it.

Five continuous minutes of health reset the counter to zero. A manual
`/restart`, `/start` or `/reset` also resets it — the user asked for it.

The BFF stays up when it is `opencode` that was stopped, and shows the incident
plus **Start engine**. When the stopped service is the BFF itself, the UI is
down: the state persists in the supervisor volume and is shown the next time it
starts; an optional webhook is the external notification.

### Notifications

`WATCHDOG_WEBHOOK_URL` receives a small JSON body on `incident`, `restarted`
and `circuit_open`. It is best effort (5 s timeout, never retried, never blocks
the restart). Use a secret URL (ntfy topic, Slack webhook, …).

## 2. Configuration

All values are optional; the defaults are the documented behavior.

| Variable | Default | Meaning |
|---|---|---|
| `WATCHDOG_TOKEN` | empty | Shared BFF ↔ watchdog token (`openssl rand -hex 32`). Empty keeps automatic restarts but disables `/status` and the manual controls (`supervisor: false`). |
| `WATCHDOG_PROJECT` | `masterhand` | Compose project whose labels are resolved. |
| `WATCHDOG_SERVICES` | `masterhand,opencode` | Allowlist. |
| `WATCHDOG_MAX_ATTEMPTS` | `3` | Restarts before the circuit opens. |
| `WATCHDOG_STABILITY_MS` | `300000` | Continuous health that resets the budget. |
| `WATCHDOG_STARTUP_GRACE_MS` | `180000` | No judgment after a start. |
| `WATCHDOG_RESTART_COOLDOWN_MS` | `30000` | Minimum gap between attempts. |
| `WATCHDOG_UNHEALTHY_SAMPLES` | `2` | Consecutive unhealthy samples. |
| `WATCHDOG_MEMORY_SAMPLES` / `_PCT` | `6` / `95` | Memory warning window/threshold (never a restart by itself). |
| `WATCHDOG_STOP_ON_CIRCUIT` | `true` | Stop the service when the budget is exhausted. |
| `WATCHDOG_WEBHOOK_URL` | empty | Optional external alert. |
| `RESILIENCE_AUTO_RESUME` | `true` | Re-drive in-flight goals/scheduled runs. |
| `RESILIENCE_AUTO_CONTINUE_CHATS` | `true` | Send one continuation prompt for interrupted chats. |
| `RESILIENCE_MAX_CHAT_RESUMES` | `3` | Maximum chats continued per incident. |
| `RESILIENCE_RESUME_GAP_MS` | `30000` | Gap between two automatic continuations. |
| `RESILIENCE_RECOVERY_TIMEOUT_MS` | `60000` | How long to wait for opencode after a reconnect. |
| `RESILIENCE_RECOVERY_MIN_OUTAGE_MS` | `3000` | A shorter SSE blip is not a restart. |
| `RESILIENCE_HEALTH_GRACE_MS` | `30000` | Stable time before a chat continuation is injected and before the scheduled-run tick may re-fire (0–5 min). |

The BFF reaches the sidecar at `http://watchdog:8080` (set in Compose). The
token is never sent to a client.

## 3. What is resumed (and what is not)

A **turn journal** (`turn_journal`, migration v6) records
`session.execution.started` and closes it on `succeeded`/`failed`/
`interrupted`/`session.deleted`. A row still `running` after a reconnect is a
turn that died.

- **Goal Mode:** a run awaiting a phase is first reconciled by the watchdog
  (last assistant message vs. the persisted baseline), so a prompt that landed
  is never replayed. A run caught between phases re-drives from its persisted
  phase. `recovery_attempts` is bounded (2 per run); a user pause/cancel and an
  `error` run are never resumed. The same applies after a BFF restart.
- **Scheduled tasks:** an idle session is not proof of success. The run is
  `completed` only if a completed assistant message is newer than the run;
  otherwise it is `interrupted` and re-fired **once** with a crash-context
  prefix. The 20 s tick and the engine recovery share one single-flight
  classification (the tick owns the transition; recovery reuses the pass), so
  the run cannot be marked interrupted by one and re-fired by the other. Paused
  tasks are not re-fired.
- **Chats:** at most 3 per incident, serialized with a gap. The continuation is
  a **new** prompt with the `masterhand.resume` marker; the text states that
  MasterHand restarted the engine/BFF, that work may be lost, that the agent
  must check the current state before repeating side effects, and that heavy
  work must be split or avoided to prevent another OOM. User aborts, completed
  turns and internal goal/scheduler/subagent sessions are never continued. If
  the marker lookup cannot prove the outcome, the turn is `ambiguous` and the
  UI offers **Continue**; it is never retried blind.
- **Not resumed:** managed dev servers (their PTY dies with the engine; start
  them again from Run & preview) and preview tunnels (quick-tunnel URLs are
  ephemeral).

When the circuit is open, the BFF pauses the in-flight goal runs and marks the
open chat turns interrupted; it does not inject prompts into a stopped engine.
Starting the engine from the banner resets the circuit; the runs can be
resumed manually.

## 4. Operating it

```bash
# Watch the supervisor decisions (restarts, budget, circuit).
docker compose -f deploy/docker-compose.yml logs -f watchdog

# Service state/health (the BFF also shows it in /api/status.engine).
docker compose -f deploy/docker-compose.yml ps

# Start a service the supervisor stopped after the circuit opened.
docker compose -f deploy/docker-compose.yml start opencode
docker compose -f deploy/docker-compose.yml start masterhand

# Manual restart/reset through the token (the UI button does the same).
docker compose -f deploy/docker-compose.yml exec masterhand sh -c \
  'curl -fsS -X POST -H "Authorization: Bearer $WATCHDOG_TOKEN" \
   -H "content-type: application/json" -d "{\"service\":\"opencode\"}" \
   http://watchdog:8080/restart'

# Inspect the persisted budget/incidents.
docker run --rm -v masterhand_watchdog_state:/state alpine cat /state/watchdog.json
```

Notes:

- A manually stopped container stays stopped after a host reboot
  (`unless-stopped` only revives containers that were running); start it on
  purpose.
- `docker restart` keeps the container and its environment. If you changed
  limits or env vars, recreate with `docker compose up -d` instead.
- The supervisor's own state is a small JSON file on `watchdog_state`; losing
  it only resets the budget.
- Rotate `WATCHDOG_TOKEN` by updating `deploy/.env` and recreating the BFF and
  the watchdog. The token is a secret: the Docker socket is root-equivalent.

## 5. Verifying a change

```bash
# Unit: budget, stability window, circuit, external restart/recreate, state.
node --test scripts/watchdog.test.mjs

# BFF recovery, caps and guards.
npx vitest run apps/server/test/engine.test.ts apps/server/test/journal.test.ts

# End-to-end: hang a turn, take the mock offline/online, assert the prompt.
npm run test:e2e -- --project=smoke --workers=1 tests/resilience.spec.ts
```

Real Docker drill (safe, separate project): create a container with a 64 MB
limit and a memory hog, give it the labels the watchdog filters on
(`com.docker.compose.project=watchdog-drill`,
`com.docker.compose.service=victim`), run a second watchdog with
`WATCHDOG_PROJECT=watchdog-drill WATCHDOG_SERVICES=victim`, and confirm the
three restarts, the stop and the manual reset. The production stack is not
touched.

## 6. Troubleshooting

| Symptom | Check |
|---|---|
| Banner shows `supervisor: false` | `WATCHDOG_TOKEN` is empty or the watchdog is not running; automatic restarts still work. |
| `503 supervisor_unavailable` on Start engine | `docker compose ps watchdog`, `docker compose logs watchdog`, and the token match on both services. |
| Engine stopped and the banner says the circuit is open | Start it from the banner or `docker compose start opencode`; the budget resets. |
| A restarted engine lost a chat turn | The journal may still be `running`/`interrupted`; `/api/turns` and the chat's **Continue** action. If the turn is `ambiguous`, review the session before continuing. |
| Restarts happen during a legitimate heavy build | Raise `OPENCODE_MEMORY_LIMIT`/`OPENCODE_HEAP_MB` or `OPENCODE_CPUS_LIMIT`; the memory warning is not a restart. Check `docker stats`. |
| The supervisor itself restarts | It has its own healthcheck and `restart: unless-stopped`; its state file resumes the budget. |
| Host OOM | The workload is protected by `oom_score_adj`/`pids`; check `docker inspect` for `OOMKilled` and the host logs. |

## 7. Rollback and compatibility

The journal and `recovery_attempts` are an **additive** migration (v6): no
existing row is rewritten. A database written by this version has
`user_version = 6`; an **older** BFF refuses a newer schema (forward-only), so
rolling the image back requires restoring the pre-upgrade backup (see
`docs/runbooks/backups.md`) or staying on the new image. Take a backup before a
major upgrade as usual.

Clients are additive: `BffStatus.engine`, `/api/turns`,
`POST /api/sessions/:id/resume` and `POST /api/engine/*` are ignored by older
clients; new clients hide the controls when `engine` is absent.
