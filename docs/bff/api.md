# MasterHand BFF API

Verified on **2026-10-02** against the implementation (`apps/server/src/app.ts`).

Base URL: the deployer's origin (in development, `http://127.0.0.1:8787`).

## Authentication

MasterHand accepts two credential types on protected routes:

- **Web / desktop:** `POST /api/login` validates the password and sets a session cookie.
  - Cookie `mh_session`: `HttpOnly`, `Secure` (configurable with `COOKIE_SECURE`), `SameSite=Strict`, HMAC-signed (`SESSION_SECRET`), TTL `SESSION_TTL_HOURS` (30 days by default).
- **Native (mobile):** `POST /api/devices` validates the password and returns a signed Bearer token plus a device record. Clients send `Authorization: Bearer <token>` on every request. Tokens are revoked by deleting the device.

Other rules:

- Rate limit: 5 attempts per IP every 15 minutes (`429` when exceeded) shared by both login routes. Keyed on the real socket peer address (`getConnInfo`), not `X-Forwarded-For`: that header is client-controlled and would let an attacker rotate the key (`unknown` when the socket address is unavailable). The limiter is **in-memory**: a BFF restart clears the window (accepted for a single-user self-hosted tool).
- Mutations (`POST`/`PATCH`/...) with an `Origin` header must match the `Host`; otherwise `403`. Origins listed in `ALLOWED_ORIGINS` are also allowed (in development the Vite origins are added automatically). Bearer requests are exempt: browsers never attach tokens automatically, so they carry no CSRF risk.
- Protected routes: everything under `/api/*` except `/api/health`, `/api/login`, `/api/logout` and `POST /api/devices`.

## Public endpoints

| Method | Route | Response | Notes |
|---|---|---|---|
| `GET` | `/api/health` | `{ ok: true }` or `503 { ok: false, error: "storage_unavailable" }` | BFF healthcheck (no auth). Readiness includes the database (`SELECT 1`); Docker marks the container unhealthy on a 503 but does **not** restart it (only a crash triggers `restart: unless-stopped`) |
| `POST` | `/api/login` | `{ ok: true }` + `Set-Cookie` | Body: `{ "password": "..." }`; `400` without body, `401` wrong password, `429` rate limit |
| `POST` | `/api/devices` | `201 { token, device }` | Body: `{ "password": "...", "name": "Pixel 9" }`; issues a device token. `400` invalid, `401` wrong password, `429` rate limit |
| `POST` | `/api/logout` | `{ ok: true }` | Clears the session cookie |

`device` shape: `{ id, name, createdAt, lastUsedAt }`.

`SlashCommand` shape: `{ name, description?, arguments }` where each argument is `{ position, freeForm, suggestions }` (`position` `0` = free-form `$ARGUMENTS`, `1..N` = `$1..$N`). Hints are derived from the command's own template and description only — never generated.

## Protected endpoints (cookie or Bearer required; `401` without credentials)

| Method | Route | Response | Notes |
|---|---|---|---|
| `GET` | `/api/status` | `{ ok: true, opencode: { healthy, version?, error? }, preview: { enabled, available, portRange }, storage: { ok, freeBytes, low } }` | Calls opencode's `/api/info` with a 3s timeout; on failure returns `healthy: false` plus `error: "unauthorized"` (opencode rejected the BFF credentials) or `"unreachable"`. `preview.available` reports whether the `cloudflared` binary can be executed. `storage.ok` is false when the database does not answer, `storage.freeBytes` is the data-volume headroom (`null` when unreadable) and `storage.low` is true below `DISK_LOW_WATERMARK_MB` |
| `GET` | `/api/events` | SSE | Re-emits opencode v2 events from **all locations** (hub on `/api/event`); first event `hello` with `{ connected }`; `ping` every 25s; synthetic `hub.connected` / `hub.disconnected` events (`data: { connected }`) whenever the hub's upstream connection changes, so clients refresh the status indicator without waiting for a poll; each client has a bounded frame queue (1024): a slow/zero-window client that falls behind is dropped instead of buffering the stream in memory — it reconnects and reconciles (SSE has no replay) |
| `GET` | `/api/audit` | `{ events: AuditEvent[] }` | Blocked actions, newest first (`?limit=`, max 500, default 100). `permission_denied` events come from opencode tool failures with `error.type = "permission.rejected"`, correlated with the command from the preceding `session.tool.called` event |
| `DELETE` | `/api/audit` | `{ ok: true }` | Clears the log |
| `GET` | `/api/providers/custom` | `{ providers: CustomProvider[] }` | MasterHand-managed OpenAI-compatible providers (read from the config file it owns). `500 custom_providers_corrupt` when the file is not valid JSON (never overwritten) |
| `POST` | `/api/providers/custom` | `201 { provider, connected }` | Body `{ id, name, baseURL, package?, models, headers?, key?, label? }`. **Upsert by id** (retry-safe); writes the provider to opencode's config file, then connects `key` best-effort (`connected: false` when opencode lagged or none was sent). `400` validation codes (`invalid_id`, `invalid_name`, `invalid_base_url`, `invalid_package`, `invalid_models`, `invalid_headers`), `503 custom_providers_unwritable` on a read-only/full disk |
| `DELETE` | `/api/providers/custom/:id` | `{ ok: true }` | Removes the provider from the config and its stored credentials (best effort). Idempotent |
| `POST` | `/api/providers/custom/models` | `{ models: CustomProviderModel[] }` | Discovers the models of a **not-yet-registered** provider from its OpenAI-compatible `/models` endpoint (the add dialog fills the list automatically). Body `{ baseURL, key?, headers? }`; read-only, the transient key is only forwarded upstream. `400` validation codes (`invalid_body`, `invalid_base_url`, `invalid_headers`, `invalid_key`), `502 provider_unauthorized`/`provider_unreachable`/`provider_failed`/`provider_invalid_response`/`provider_no_models`, `504 provider_timeout` |
| `GET` | `/api/devices` | `{ devices: DeviceRecord[] }` | Lists registered devices |
| `DELETE` | `/api/devices/:id` | `{ ok: true }` | Revokes a device token |
| `GET` | `/api/commands` | `{ commands: SlashCommand[] }` | Slash commands for a location (`?directory=/abs`), with deterministic argument hints. Composes opencode's `/api/command` catalog with the `template` only `/api/config` exposes (`$ARGUMENTS`, `$1..$N`, `[a\|b\|c]`), so raw config never reaches the clients. `502` when opencode is unreachable; a broken config degrades to commands without hints |
| `GET` | `/api/workspaces` | `{ workspaces: WorkspaceRecord[] }` | Workspaces, oldest first |
| `POST` | `/api/workspaces` | `201 { workspace }` | Body: `{ "name": "my-project" }`. The BFF creates `<WORKSPACES_ROOT>/<name>` (mkdir -p), makes it its **own git root** (`git init` + empty first commit) and returns it. `name` becomes both the folder and the display name. `400` invalid name (separators, traversal, leading dot, >64 chars), `409` already registered |
| `DELETE` | `/api/workspaces/:id` | `{ ok: true }` | Removes the workspace from MasterHand's list and cleans up its isolated worktrees and records. With `?deleteFiles=1` it also deletes the folder and its files from disk (only when the path is inside `WORKSPACES_ROOT`, otherwise `403`); without it, files and opencode sessions are untouched. `404` unknown workspace |
| `GET` | `/api/workspaces/:id/directories` | `{ directories: string[] }` | Workspace folder plus every isolated worktree of the workspace (used to reconcile pending permissions per directory) |
| `GET` | `/api/workspaces/:id/sessions` | `{ sessions: Session[] }` | Aggregates opencode sessions from the workspace folder and every worktree. Isolated sessions (and subagent children) carry `isolation: { isolated: true, worktreePath, branch, baseRef, pushed, prUrl }`. `502` when opencode is unreachable |
| `POST` | `/api/workspaces/:id/sessions` | `201 { session, isolation }` | Body: `{ "isolated": true, "marker": "session_..." }` both optional. Standard sessions are created in the workspace folder (`isolation: null`); legacy workspaces are made their own git root first. Isolated sessions `git init` the workspace when needed, create a worktree under `WORKTREES_ROOT`, create the opencode session there and return the `isolation` metadata. A valid `marker` (8–128 chars of `[A-Za-z0-9._-]`) is persisted as opencode session metadata `masterhand.create`, so a client whose create response was lost can reconcile against the list; invalid markers are ignored. In both cases the BFF then writes the `masterhand.workspace` and `masterhand.process` instructions and sets the write/process permission guards (see below). On failure the worktree is rolled back (`500 isolation_failed`) |
| `DELETE` | `/api/workspaces/:id/sessions/:sessionID` | `{ ok: true }` | Deletes the opencode session (the session id resolves its location; no `directory` needed). For isolated sessions it also removes the worktree and the branch. `404` unknown workspace |
| `POST` | `/api/isolated-sessions/:sessionID/finish` | `{ committed, pushed, prUrl, branch, path, error }` | Commits everything in the worktree. With a remote it pushes the branch and tries `gh`/`glab` for the PR, falling back to a provider compare URL; `error` reports a failed push. Retrying is safe: the commit is idempotent and a recorded `pr_url` wins, so a retry never creates a second PR. `404` for unknown/non-isolated sessions |
| `GET` | `/api/workspaces/:id/branches` | `{ current, branches }` | Local branches of the workspace folder (opencode's VCS API is read-only, so these run over git). `404` unknown workspace, `502 git_failed` when git fails |
| `POST` | `/api/workspaces/:id/branches` | `201 { current, branches }` | Body: `{ name, base? }`. Creates and checks out a branch (from `base`, default HEAD). Guards: valid ref name (`400 invalid_branch_name`), not already existing (`409 branch_exists`), `base` exists (`404 branch_not_found`), no session of the workspace is busy (`409 workspace_busy`). A git deadline answers `504 git_timeout` — the mutation may have applied, so clients reconcile and never auto-retry |
| `POST` | `/api/workspaces/:id/checkout` | `{ current, branches }` | Body: `{ name }`. Switches to an existing local branch. Same busy guard plus a clean-tree requirement (`409 dirty_worktree`; a switch would clobber uncommitted work); `404 branch_not_found`, `504 git_timeout` as above |
| `GET` | `/api/sessions/:sessionID/preview` | `{ preview: PreviewStatus }` | Current preview state for the session. `404 preview_disabled` when `PREVIEW_ENABLED=false` |
| `POST` | `/api/sessions/:sessionID/preview` | `{ preview: PreviewStatus }` | Starts a Cloudflare quick tunnel to the session's reserved port. `409 preview_not_running` when nothing listens on the port, `503 preview_unavailable` when `cloudflared` is missing, `503 preview_ports_exhausted` when the pool is drained, `502` on tunnel failure. Idempotent while running |
| `DELETE` | `/api/sessions/:sessionID/preview` | `{ ok: true }` | Stops the tunnel (the reserved port is kept for a later restart) |
| `GET` | `/api/workspaces/:id/run` | `{ run: WorkspaceRunRecord \| null }` | The workspace's managed run configuration |
| `PUT` | `/api/workspaces/:id/run` | `{ run: WorkspaceRunRecord }` | Body: `{ command, args, cwd? }` (argv, no shell). Validated: shells/process-killers rejected (`400`), `cwd` must stay inside the workspace, arguments bounded. Saved with `source: "user"` |
| `POST` | `/api/workspaces/:id/run/detect` | `{ run: RunCandidate }` | Reads and validates the agent-proposed `.masterhand/run.json`. `404 run_not_found` when missing, `400` when invalid |
| `GET` | `/api/sessions/:sessionID/run?workspace=<id>` | `{ run: RunStatus }` | Current state (`stopped`/`running`), pid and reserved port. Adopts a still-running PTY by its `masterhand:<sessionID>` title after a BFF restart |
| `POST` | `/api/sessions/:sessionID/run?workspace=<id>` | `{ run: RunStatus }` | Starts the configured command through opencode's PTY API (argv, `{port}` replaced, `PORT` in env, cwd = the session's directory/worktree). `404 run_not_configured`, `502 run_spawn_failed` |
| `DELETE` | `/api/sessions/:sessionID/run?workspace=<id>` | `{ ok: true }` | Stops the exact PTY MasterHand created (`DELETE /api/pty/:id`); nothing else is signalled |

`workspace` shape: `{ id, name, path, createdAt }`. Each workspace is a subfolder that MasterHand creates and owns under `WORKSPACES_ROOT`, so it is always a single, isolated directory. opencode has no project-deletion endpoint, so deleting the record in MasterHand (optionally with its files) is how a workspace goes away.

`isolation` shape: `{ isolated: true, worktreePath, branch, baseRef, pushed?, prUrl? }`. Worktrees live at `<WORKTREES_ROOT>/<workspace>/<token>` (default `<WORKSPACES_ROOT>/.worktrees`) with branch `masterhand/<slug>-<token>`; one branch per worktree (git forbids checking out the same branch twice).

## Session previews

Each session gets a **fixed port** from `PREVIEW_PORT_RANGE` on session creation (persisted in SQLite so it survives BFF restarts and the same dev server can be re-exposed). While previews are enabled, the BFF writes a session instruction entry (`PUT /api/experimental/session/:id/instructions/entries/masterhand.preview`) telling the agent to bind any web server to `0.0.0.0:<port>`; opencode includes it in the model's system context on every turn. The BFF then starts `cloudflared tunnel --no-autoupdate --url http://<PREVIEW_ORIGIN>:<port> --http-host-header localhost:<port>` (a Cloudflare **quick tunnel**, see `deploy/server.Dockerfile`) and captures the random `https://<name>.trycloudflare.com` URL from its output. The `--http-host-header` rewrite is required: framework dev servers reject the public hostname (Vite's `server.allowedHosts` returns `403 Blocked request`), and `localhost` is always allowed. Once the URL is captured, the BFF polls it for up to `PREVIEW_READINESS_MS` until it answers (the edge can take a few seconds to serve a new hostname), so `running` means the preview really loads.

`PreviewStatus` shape: `{ status: "stopped" | "starting" | "running" | "error", url, port, error }`. The tunnel process lives in the BFF container; `PREVIEW_ORIGIN` is the host where the dev server listens as seen from there (`opencode` in Compose, `127.0.0.1` in native dev). Tunnels stop on `DELETE`, on session deletion — including `session.deleted` events emitted by opencode when the session disappears outside MasterHand — and on BFF shutdown. Live tunnel PIDs are persisted (`preview-tunnels.json` in `DATA_DIR`); startup reaps orphaned ones left by a hard crash, killing only PIDs still confirmed to be `cloudflared`.

> Quick tunnels are **public and ephemeral**: anyone with the random URL can reach the preview, and the URL changes on every start. Use them for testing only.

## Managed run (dev-server lifecycle)

MasterHand owns the dev-server process so agents never start or kill servers themselves (the broad-kill incident this feature prevents). A **run configuration** is stored per workspace and reused by every session:

- The agent declares the command in `<workspace>/.masterhand/run.json` (`{ "command": "npm", "args": ["run", "dev", "--", "--host", "0.0.0.0", "--port", "{port}"] }`); the BFF validates it (`POST /run/detect`) and the user applies or edits it in the UI. A saved config carries `source: "agent" | "user"`.
- The command is **argv, no shell**: `command` is a single executable and `args` a bounded list, so a shell string cannot smuggle anything. Shells and process-killers (`sh`, `bash`, `pkill`, `killall`, `xargs`, `docker`, `systemctl`, …) are rejected; `cwd` must resolve inside the workspace.
- On Start the BFF calls opencode's `POST /api/pty` with the session's reserved preview port substituted for `{port}` (and `PORT` in the env), in the session's directory (worktree for isolated sessions). On Stop it calls `DELETE /api/pty/:id`, which kills exactly that process tree — no `pkill`, no port sweeps.
- The PTY is titled `masterhand:<sessionID>`; after a BFF restart the state endpoint adopts a still-running PTY instead of spawning a second server. Concurrent starts coalesce per session (one PTY even if two devices press Start at once). Deleting the session — or an out-of-band `session.deleted` event — forgets it.
- Session creation writes a `masterhand.run` instruction telling the agent not to manage servers itself; the `masterhand.preview` instruction still carries the reserved port and the tunnel-host allowlist advice.

## Goal Mode (`/goal`)

A goal run wraps a session in an adversarial review loop: the main agent works the goal, an internal **critic** challenges the claimed completion (it may read files and run commands/tests to falsify), and an impartial **judge** decides. The loop repeats until approval or the round cap. All prompts are server-side constants (English); clients never build them.

| Method | Route | Notes |
|---|---|---|
| `POST` | `/api/sessions/:id/goal` | Body `{ goal, model?, agent? }` where `model` is `{ providerID, id, variant? }` (the composer selection) and `agent` the composer agent: both are applied to the session before the goal prompt, exactly like a normal prompt would. Writes the `masterhand.goal` instruction and prompts the main session. `201 { goal }`. `400 invalid_goal`/`invalid_model`, `409 goal_running` (already active), `409 session_busy` (mid-turn), `404 session_not_found`, `502 opencode_unreachable`/`goal_ambiguous`. |
| `GET` | `/api/sessions/:id/goal` | `{ goal: GoalRun \| null }` — the durable run snapshot. |
| `POST` | `/api/sessions/:id/goal/pause` | Interrupts the awaited phase; run becomes `paused` (resumable). |
| `POST` | `/api/sessions/:id/goal/resume` | Re-drives the paused (or errored) phase; from a cap pause it extends the budget and feeds the judge's required changes back to the main agent. |
| `POST` | `/api/sessions/:id/goal/cancel` | Interrupts the awaited turn, removes the internal critic/judge sessions and the goal instruction; run becomes `cancelled` (history kept). |
| `GET` / `PUT` | `/api/goal/settings` | Single-user `{ maxRounds (default 5, 1..50), criticModel, judgeModel }`; `provider/model` refs are validated against `/api/model` (an empty catalog accepts well-formed refs). |

State machine: `running → critiquing → judging`, plus `approved`, `paused` (cap reached or manual), `cancelled` and `error`. Critic and judge are **internal sessions**: the pinned opencode (v2.0.6) silently drops `parentID` on `POST /api/session` (upstream added the field later), so they are created with `parentID` for forward compatibility plus a stable `masterhand.goal.internal` metadata role, and `GET /workspaces/:id/sessions` annotates them with `goalRole` (`critic`/`judge`) — resolved from that marker, the run store and, for legacy sessions, the `masterhand.goal.role` prefix. Clients filter the annotation through `rootSessions`, so the internal sessions never list while their work stays renderable. Deleting the main session (`forget`), cancelling a run, and starting a new run over a terminal one remove the internal sessions explicitly (nothing cascades upstream), and a lost create response is reconciled by looking the unique marker up **by directory** — not by `parentID`, which the pinned server drops, so a parent-scoped lookup would replay the create and duplicate the session. Completion is declared with markers parsed tolerantly from the last assistant reply: `<masterhand:goal status="complete|blocked">{…}</masterhand:goal>`, `<masterhand:critique>{…}</masterhand:critique>`, `<masterhand:verdict>{…}</masterhand:verdict>`; clients split the same blocks out of assistant text and render them as cards (never raw JSON).

Reliability (see `ARCHITECTURE.md` §4.11 and `docs/past-mistakes.md`):

- Every opencode call goes through the shared retry engine (ADR-32): idempotent calls retry transient failures (429/5xx/network) with incremental backoff; internal session creation and prompts reconcile their persisted marker first, so a retry can never duplicate them.
- opencode's own provider retries (`session.retry.scheduled`) only update the run note; a failed turn re-drives its phase up to 3 times (2s/4s/8s). A missing completion marker gets a single corrective prompt, then the run errors.
- A watchdog reconciles lost `session.idle` events (the awaited session is no longer active), `server.connected` refetches the run, and after a BFF restart in-flight runs become `paused` — never auto-resumed. Deleting the main session drops the run; deleting an awaited internal session fails it.
- Every transition is broadcast as a synthetic `goal.updated` frame on `/api/events` (same payload as `GET …/goal`), so clients never poll.

## Workspace isolation & guardrails

opencode resolves project-scoped features (`/init`, `/review`, `AGENTS.md` discovery, the reported "workspace root") from its **`project.directory`**, computed by walking up to the nearest `.git`/`.hg` — it does not use the session's `location.directory` for them. A workspace nested inside the MasterHand repo would therefore make opencode target the **server** repo. MasterHand prevents that on two layers:

1. **Every workspace is its own git root.** The BFF runs `git init` (+ empty first commit) on workspace creation and, for legacy folders, before the first session. opencode then stops at the workspace when resolving its project root.
2. **Per-session guardrails**, written best-effort on session creation (a failure never blocks the session):
   - An instruction entry `PUT /api/experimental/session/:id/instructions/entries/masterhand.workspace` (key `masterhand.workspace`, independent from `masterhand.preview`) pinning the agent to its exact directory: that folder is its project root and `AGENTS.md` belongs at `<dir>/AGENTS.md`; it must not touch anything outside it, and must ignore out-of-workspace paths a prompt may mention (e.g. the `AGENTS.md` path of `/init`).
   - An instruction entry `masterhand.process` (`processSystemPrompt()`) forbidding broad process kills (`pkill`, `killall`, `fuser`, `kill $(...)`, `npm run dev:stop`) and pointing at the supported lifecycle: capture the PID you started and `kill <that pid>`, or use MasterHand's run/preview controls.
   - A single `PATCH /api/session/:id` with `permissions` combining both guards (the field replaces the whole ruleset):
     - `external_directory` is allowed and `edit` (the action the write, edit and patch tools assert) is denied on absolute (`/*`, `?:/*`) and `../*` resources. opencode tags files outside the session directory with an absolute or `../`-prefixed resource and workspace files with a plain relative one, so **writes outside the workspace are blocked while reads stay allowed**.
     - `shell` is denied on the broad-kill patterns (`pkill*`, `killall*`, `fuser*`, `kill $*`, `kill \`*`, `kill -1*`, `npm run dev:stop*`, `docker compose down*`, `systemctl stop*`, `shutdown*`, …), plus the legacy `bash` action for older servers. `deny` is deliberate: MasterHand's auto-accept answers `ask` requests automatically, so only an explicit deny is enforced regardless. A numeric `kill <pid>` stays allowed. Verified against opencode v2.0.21 (the v2 shell tool asserts the `shell` action; a denied command surfaces as a tool part with `error.type = "permission.rejected"`).

This is defense in depth; it does **not** sandbox shell access in general (an agent can still run any allowed command), which remains a documented limitation (see `ARCHITECTURE.md` §5).

## Proxy to opencode

| Method | Route | Notes |
|---|---|---|
| `*` | `/api/oc/*` | Forwards to `OPENCODE_URL` (e.g. `http://opencode:4096`) injecting `Authorization: Basic` with `OPENCODE_SERVER_PASSWORD`. The `/api/oc` prefix is removed: `/api/oc/api/info` → `GET /api/info`. Preserves method, body, query and `content-type` byte-for-byte (including the `location[directory]` query used to target a workspace). An opencode `401/403` is converted into `502 { error: "opencode_unauthorized" }` instead of being relayed (relaying it would sign the MasterHand user out). SSE streaming without buffering (`cache-control: no-cache`, `x-accel-buffering: no`). `502 opencode_unreachable` if opencode does not answer. `504 { error: "opencode_timeout" }` when the upstream stalls past the 60s proxy deadline (the clients abort sooner with their own request timeout). |

Transport hardening (shared with every internal call, ADR-32): `GET`/`HEAD` and the idempotent `agent`/`model` switches retry transient upstream statuses (429/5xx) and fast network failures with incremental backoff, and a `POST …/prompt` carrying the client's `masterhand.delivery` marker is retried too — after verifying through `GET /api/session/:id/message` that the marker did **not** already land, so a replay can never duplicate the turn. Mutations without a reconciliation marker (slash commands, permission/form replies, forks) stay single-shot; the client's own lost-response reconciliation covers them.

The same proxy carries the provider integration/credential endpoints behind Settings > Providers (issue #128), verified against the pinned opencode v2.0.6: `GET /api/oc/api/integration`, `POST /api/oc/api/integration/{id}/connect/key`, `GET /api/oc/api/credential`, `POST /api/oc/api/credential/{id}/activate` and `DELETE /api/oc/api/credential/{id}`. No dedicated BFF route exists: an API key transits client → BFF → opencode only, is stored in opencode's data volume, and is never persisted, logged or echoed back by MasterHand.

## Custom OpenAI-compatible providers

opencode has **no HTTP API to register a provider** — the definition only lives in its config file. MasterHand therefore owns a dedicated file (`~/.config/opencode/masterhand-providers.json`, loaded by opencode through `OPENCODE_CONFIG`; see `ARCHITECTURE.md` ADR-30) and writes it over the shared `opencode_config` volume:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "acme": {
      "name": "Acme",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.acme.example/v1" },
      "models": { "acme-coder": { "name": "Acme Coder" } }
    }
  }
}
```

- `package` is `@opencode/ai/providers/openai-compatible` (chat completions) or `@opencode/ai/providers/openai` (responses); verified against the pinned **2.0.6**.
- Writes are atomic (temp file + rename) and serialized; unknown `providers` entries are preserved, and a malformed file is **never overwritten** (the routes answer `custom_providers_corrupt`).
- The **API key never enters the config**: `POST /api/providers/custom` connects it through opencode's `connect/key` with a bounded retry (opencode registers the integration only after reloading the config, answering `404` until then; a `404` created nothing, so retrying is safe). A failed connect never fails the create — the card offers Connect.
- The add dialog **loads the model list automatically**: once the base URL is valid, it debounces a `POST /api/providers/custom/models`, which calls `<baseURL>/models` on a 10 s budget and returns `{ id, name? }` entries (accepts the OpenAI `{ data }` shape, `{ models }` or a bare array; deduplicated, cap 200 — the same cap the config write enforces, so a discovered list can never be rejected as `invalid_models`). It is read-only and the transient key is only forwarded to the provider. There is **no manual model entry**: a failed discovery shows `This provider does not expose models.` and keeps Create disabled until the list loads (an auth failure is reported separately). Because self-hosted installs commonly point the base URL at a LAN address, no host allowlist applies — the URL is the same one opencode will call once the provider is saved.
- opencode reloads the watched config dir, so `/api/model` and `/api/integration` pick the provider up without a restart; a custom provider then exposes a `key` method, and its connection state shows up in `GET /api/integration/{id}` (`/api/credential` does **not** list it).

Examples:

```bash
# create a session in a workspace (location travels in the body)
curl -X POST https://your-origin.example/api/oc/api/session \
  -H 'content-type: application/json' \
  -d '{"location":{"directory":"/workspace/my-app"}}'
# switch model and send a prompt (progress arrives over /api/events)
curl -X POST https://your-origin.example/api/oc/api/session/<id>/model \
  -H 'content-type: application/json' \
  -d '{"model":{"id":"grok-4.7","providerID":"opencode-go","variant":"high"}}'
curl -X POST https://your-origin.example/api/oc/api/session/<id>/prompt \
  -H 'content-type: application/json' \
  -d '{"text":"hello"}'
# answer permission
curl -X POST https://your-origin.example/api/oc/api/session/<id>/permission/<requestID>/reply \
  -H 'content-type: application/json' -d '{"decision":"once"}'
# reply to a form (the agent's `question` tool); keys come from the form's fields
curl -X POST https://your-origin.example/api/oc/api/session/<id>/form/<formID>/reply \
  -H 'content-type: application/json' -d '{"answer":{"q0":"Postgres"}}'
# list pending permissions for a workspace (to reconcile missed SSE events)
curl 'https://your-origin.example/api/oc/api/permission/request?location%5Bdirectory%5D=/workspace/my-app'
# native login (device token)
curl -X POST https://your-origin.example/api/devices \
  -H 'content-type: application/json' -d '{"password":"...","name":"Pixel 9"}'
```

## Error shapes

- Any uncaught route failure answers JSON instead of a bare 500: `500 { error: "internal_error" }` (method/path logged) or `503 { error: "storage_unavailable" }` when the failure is a SQLite error (disk full, read-only, corrupt).
- Expected conflicts are mapped: `POST /api/workspaces` answers `409 already_exists` when the insert races the path pre-check, and preview-port allocation retries a `UNIQUE(port)` race before giving up.
- Advisory writes (device `lastUsedAt`, the audit log) never fail the request; the first failure is logged once.

## Relevant environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MASTERHAND_PASSWORD` | — (required) | Access password |
| `SESSION_SECRET` | — (required) | Cookie and token signing |
| `SESSION_TTL_HOURS` | `720` | Session/device token lifetime |
| `COOKIE_SECURE` | `true` | Cookie `Secure` flag |
| `ALLOWED_ORIGINS` | — | Comma-separated extra origins allowed on mutations (in dev the Vite origins are added) |
| `PORT` | `8787` | BFF port |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | opencode upstream |
| `OPENCODE_TIMEOUT_MS` | `10000` | Deadline for the BFF's internal opencode calls (session listing, `/api/commands`, session create/delete, instruction/permission writes, PTY/run control). A missed deadline answers `504 { error: "opencode_timeout" }` (minimum 1000 ms); the public `/api/oc/*` proxy keeps its own 60s budget |
| `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` | — / `opencode` | Basic auth to opencode |
| `DATA_DIR` | `<repo-root>/data` | SQLite path (`/data` in Docker). Relative values resolve against the repo root |
| `WORKSPACES_ROOT` | `<repo-root>/workspace` | Base directory where workspaces are created as subfolders. Point it at the same folder opencode sees (e.g. `/workspace` in Docker). Relative values resolve against the repo root |
| `WORKTREES_ROOT` | `<WORKSPACES_ROOT>/.worktrees` | Base directory for per-session git worktrees. Must stay inside the mount opencode sees |
| `GIT_COMMIT_NAME` / `GIT_COMMIT_EMAIL` | `MasterHand` / `masterhand@localhost` | Author for commits MasterHand creates in isolated worktrees |
| `PREVIEW_ENABLED` | `true` | Enables session previews (quick tunnels). When `false`, the preview routes return `404` and prompts are untouched |
| `PREVIEW_ORIGIN` | host of `OPENCODE_URL` | Host where the agent's dev server listens, as seen by the tunnel process (`opencode` in Compose, `127.0.0.1` in native dev) |
| `PREVIEW_PORT_RANGE` | `3200-3299` | Inclusive port pool reserved per session. Falls back to the default when malformed or outside 1024–65535 |
| `PREVIEW_READINESS_MS` | `25000` | How long the BFF waits for a fresh tunnel URL to answer before reporting `running` (quick tunnels announce the URL before the edge is ready). `0` disables the check |
| `CLOUDFLARED_BIN` | `cloudflared` | `cloudflared` executable name or path (bundled in the server image) |
| `GH_TOKEN` / `GITLAB_TOKEN` | — | Optional: credentials for `gh`/`glab` and git push inside the BFF container (see the deployment runbook) |
| `WEB_DIST` | `apps/web/dist` | Web build served by the BFF |
