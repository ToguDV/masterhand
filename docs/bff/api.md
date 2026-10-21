# MasterHand BFF API

Verified on **2026-10-20** against the implementation (`apps/server/src/app.ts`, `proxy.ts`, `runs.ts`); the proxy allowlist and managed-run isolation were verified at runtime on the dev stack (opencode 2.0.6).

Base URL: the deployer's origin (in development, `http://127.0.0.1:8787`).

## Authentication

MasterHand accepts two credential types on protected routes:

- **Web / desktop:** `POST /api/login` validates the password and sets a session cookie.
  - Cookie `mh_session`: `HttpOnly`, `Secure` (configurable with `COOKIE_SECURE`), `SameSite=Strict`, HMAC-signed (`SESSION_SECRET`), TTL `SESSION_TTL_HOURS` (30 days by default).
- **Native (mobile):** `POST /api/devices` validates the password and returns a signed Bearer token plus a device record. Clients send `Authorization: Bearer <token>` on every request. Tokens are revoked by deleting the device. Device **identity is the stable, client-generated `installID`**; `name` is only an editable display label (two phones with the same default name stay separate devices and are revoked independently).

Other rules:

- Rate limit: **5 failed attempts** per IP every 15 minutes (`429` when exceeded) shared by both login routes. Only failures are counted and a correct password is always verified first, so a successful login never consumes the budget and still succeeds after it is exhausted; a success clears the IP's window. Keyed on the real socket peer address (`getConnInfo`), not `X-Forwarded-For`: that header is client-controlled and would let an attacker rotate the key (`unknown` when the socket address is unavailable). Keys are swept after the window and the map is LRU-bounded (10 000 keys). The limiter is **in-memory**: a BFF restart clears the window (accepted for a single-user self-hosted tool). Each failure is logged as `[masterhand] login failed from <ip> at <ISO timestamp>` — never the password.
- Request bodies are bounded before parsing: login/device bodies at 64 KiB and proxied opencode bodies at `PROXY_BODY_LIMIT_MB` (10 MiB default). Oversized bodies answer `413 { error: "payload_too_large" }`; passwords longer than 1024 characters answer `400 bad_request` before hashing.
- Mutations (`POST`/`PATCH`/...) with an `Origin` header must match the `Host`; otherwise `403`. Origins listed in `ALLOWED_ORIGINS` are also allowed (in development the Vite origins are added automatically). Bearer requests are exempt: browsers never attach tokens automatically, so they carry no CSRF risk.
- Protected routes: everything under `/api/*` except `/api/health`, `/api/login`, `/api/logout` and `POST /api/devices`.

## Public endpoints

| Method | Route | Response | Notes |
|---|---|---|---|
| `GET` | `/api/health` | `{ ok: true }` or `503 { ok: false, error: "storage_unavailable" }` | BFF healthcheck (no auth). Readiness includes the database (`SELECT 1`); Docker marks the container unhealthy on a 503 but does **not** restart it (only a crash triggers `restart: unless-stopped`) |
| `POST` | `/api/login` | `{ ok: true }` + `Set-Cookie` | Body: `{ "password": "..." }`; `400` without body or password > 1024 chars, `401` wrong password, `413 payload_too_large` (> 64 KiB), `429` after 5 failed attempts |
| `POST` | `/api/devices` | `201 { token, device }` | Body: `{ "password": "...", "name": "Pixel 9", "installID": "<uuid>" }` (`installID` optional). A known `installID` reuses its row and **keeps its existing label**; an absent/empty `installID` creates a new row per login (pre-#87c behavior). A concurrent duplicate `installID` is coalesced through the unique index. `400` invalid, `401` wrong password, `413 payload_too_large` (> 64 KiB), `429` after 5 failed attempts |
| `POST` | `/api/logout` | `{ ok: true }` | Clears the session cookie |

`device` shape: `{ id, name, installID, createdAt, lastUsedAt }` (`installID` is `null` for clients that did not send one).

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
| `POST` | `/api/providers/custom/models` | `{ models: CustomProviderModel[] }` | Discovers the models of a **not-yet-registered** provider from its OpenAI-compatible `/models` endpoint (the add dialog fills the list automatically). Body `{ baseURL, key?, headers? }`; read-only, the transient key is only forwarded upstream. Targets are checked before any request: loopback, unspecified, link-local/metadata (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`), multicast and reserved addresses are refused — including hostnames that resolve to them (all resolved addresses) — while private LAN ranges stay allowed. Loopback is allowed only with the explicit `PROVIDERS_ALLOW_LOOPBACK=true` opt-in (native local providers); metadata/link-local stay blocked even then. `400` validation codes (`invalid_body`, `invalid_base_url` — malformed or blocked target — `invalid_headers`, `invalid_key`), `502 provider_unauthorized`/`provider_unreachable`/`provider_failed`/`provider_invalid_response`/`provider_no_models`, `504 provider_timeout` |
| `GET` | `/api/websearch` | `{ provider: string \| "random" \| false \| null }` | The web search source opencode uses (read from the same config file MasterHand owns). When the `websearch` key is absent it seeds the keyless default (`tinyfish`) and returns it; a present but unrecognized value reads as `null` and is never overwritten. `500 websearch_corrupt` when the file is not valid JSON |
| `PUT` | `/api/websearch` | `{ provider }` | Body `{ provider: "<source id>" \| "random" \| false }`. **Full-state replacement** (retry-safe); writes opencode's `websearch` key atomically and opencode hot-reloads it. `400 invalid_provider`/`invalid_body`, `503 websearch_unwritable`, `500 websearch_corrupt`/`websearch_failed` |
| `GET` | `/api/devices` | `{ devices: DeviceRecord[] }` | Lists registered devices |
| `DELETE` | `/api/devices/:id` | `{ ok: true }` | Revokes a device token |
| `GET` | `/api/commands` | `{ commands: SlashCommand[] }` | Slash commands for a location (`?directory=/abs`), with deterministic argument hints. Composes opencode's `/api/command` catalog with the `template` only `/api/config` exposes (`$ARGUMENTS`, `$1..$N`, `[a\|b\|c]`), so raw config never reaches the clients. `502` when opencode is unreachable; a broken config degrades to commands without hints |
| `GET` | `/api/workspaces` | `{ workspaces: WorkspaceRecord[] }` | Workspaces, oldest first |
| `POST` | `/api/workspaces` | `201 { workspace }` | Body: `{ "name": "my-project" }`. The BFF creates `<WORKSPACES_ROOT>/<name>` (mkdir -p), makes it its **own git root** (`git init` + empty first commit) and returns it. `name` becomes both the folder and the display name. `400` invalid name (separators, traversal, leading dot, >64 chars), `409` already registered |
| `DELETE` | `/api/workspaces/:id` | `{ ok: true }` | Removes the workspace. Order: `outside_root` `403` (with `deleteFiles`) → pauses every scheduler task whose directory is this folder through its serialized chain (waiting for an in-flight fire) → optional active-session guard → removes the workspace row (cascading the run config and board rows) → releases every isolated record **and every base-folder session** (best effort for the latter when opencode cannot be listed): waits for an in-flight finish, awaits the goal run's cleanup, awaits the preview forget (which waits for an in-flight tunnel start), stops the managed dev-server PTY (adopting an orphan by title), then removes the worktree and record → with `deleteFiles`, deletes the folder. The pause comes **before** the guard so a fire that was in flight settles and its session is visible to the guard instead of being deleted under it. The row goes before the children and the folder, so a folder-delete failure leaves the files without a registration. With `?deleteFiles=1` the folder is deleted after checking the base folder and every worktree for active sessions: `409 workspace_busy` when one is active, `502 busy_check_failed` when the guard cannot be evaluated (fail closed). Without `deleteFiles`, files and opencode sessions are untouched. `404` unknown workspace |
| `GET` | `/api/workspaces/:id/directories` | `{ directories: string[] }` | Workspace folder plus every isolated worktree of the workspace (used to reconcile pending permissions per directory) |
| `GET` | `/api/workspaces/:id/sessions` | `{ sessions: Session[] }` | Aggregates opencode sessions from the workspace folder and every worktree. Isolated sessions (and subagent children) carry `isolation: { isolated: true, worktreePath, branch, baseRef, pushed, prUrl }`. `502` when opencode is unreachable |
| `POST` | `/api/workspaces/:id/sessions` | `201 { session, isolation }` | Body: `{ "isolated": true, "marker": "session_..." }` both optional. Standard sessions are created in the workspace folder (`isolation: null`); legacy workspaces are made their own git root first. Isolated sessions `git init` the workspace when needed, create a worktree under `WORKTREES_ROOT`, create the opencode session there and return the `isolation` metadata. A valid `marker` (8–128 chars of `[A-Za-z0-9._-]`) is persisted as opencode session metadata `masterhand.create`, so a client whose create response was lost can reconcile against the list; invalid markers are ignored. In both cases the BFF then writes the `masterhand.workspace` and `masterhand.process` instructions and sets the write/process permission guards (see below). A **timeout** on the isolated create is ambiguous, not a failure: the BFF never removes the fresh worktree; it lists that worktree directory fresh (bypassing the 5 s aggregation cache), matches only the same `masterhand.create` marker, and when found persists the isolated-session record and answers `201 { session, isolation }` exactly like the success path (a duplicate reconcile that hits the session's primary key adopts the already-persisted record). Without the marker there is nothing to reconcile against: it answers `504 { error: "opencode_timeout" }` and leaves the worktree — and any unconfirmed session — to the startup quarantine/reconcile (#79). No isolated record exists, so the worktree directory is not aggregated and the client's list-based reconciliation can never find it; only the marker path recovers a session. A standard create has no isolation record to roll back, so when the workspace vanished while opencode was creating it the route deletes the upstream session and answers `409 workspace_busy`. For the isolated paths the route re-reads the row immediately before persisting the record (normal and timeout-recovery); when it is gone it deletes the known session, removes the worktree and answers `409 workspace_busy`. Only a non-timeout failure rolls the worktree back (`500 isolation_failed`, after deleting a known session) |
| `DELETE` | `/api/workspaces/:id/sessions/:sessionID` | `{ ok: true }` | Deletes the opencode session (the session id resolves its location; no `directory` needed), then releases its MasterHand lifecycles: waits for an in-flight finish, awaits the goal run's cleanup, awaits the preview forget, stops the managed PTY (adopting an orphan by title), and for isolated sessions then removes the worktree and branch. The release is registered synchronously before it awaits the finish map, so a finish that starts while the release is in progress answers `409 workspace_busy` instead of committing/pushing into the worktree being removed. `404` unknown workspace |
| `POST` | `/api/isolated-sessions/:sessionID/finish` | `{ committed, pushed, prUrl, branch, path, error }` | Commits everything in the worktree. With a remote it pushes the branch and asks `gh`/`glab` for the PR; when creation fails (already exists, lost response, second device) the existing PR/MR is looked up (`gh pr list --head`, `glab mr list --source-branch`) before falling back. Concurrent finishes for one session coalesce into a single commit/push/PR and every caller receives that same result. `error` reports a failed push. The compare URL is response-only when no real PR exists: it is **never persisted** as `pr_url`. Retrying is safe and monotonic: the commit is idempotent, the first real PR URL wins, `pushed` is never downgraded, and a legacy stored compare URL is replaced by the real PR on the next finish. `404` for unknown/non-isolated sessions, `409 workspace_busy` when the session's release already began (session/workspace deletion) |
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
- **Isolation:** with `MANAGED_RUN_LAUNCHER` set (Compose passes `/usr/local/bin/agent-exec`), the PTY command becomes `agent-exec --exec <command> <args>`: the helper drops to `agent` (uid 1001/gid 1000, supplementary groups cleared), clears the inherited environment and sets only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `TMPDIR` and a validated `PORT`, then execs the argv verbatim (no shell). The status keeps reporting the user's command/args, `PORT` still carries the reserved preview port, and `agent-exec` is rejected as a run command. Native development leaves the variable unset, so the run inherits the user running `opencode serve` (Docker is the only isolation path).
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

State machine: `running → critiquing → judging`, plus `approved`, `paused` (cap reached or manual), `cancelled` and `error`. Critic and judge are **internal sessions**: the pinned opencode (v2.0.6) silently drops `parentID` on `POST /api/session` (upstream added the field later), so they are created with `parentID` for forward compatibility plus a stable `masterhand.goal.internal` metadata role, and `GET /workspaces/:id/sessions` annotates them with `goalRole` (`critic`/`judge`) — resolved from that marker, the run store and, for legacy sessions, the `masterhand.goal.role` prefix. Clients filter the annotation through `rootSessions`, so the internal sessions never list while their work stays renderable; the same listing also **synthesizes the dropped `parentID`** from the run store, so opening a critic/judge session from the review cards behaves like a subagent child ("Back to main agent"). Deleting the main session (`forget`), cancelling a run, and starting a new run over a terminal one remove the internal sessions explicitly (nothing cascades upstream), and a lost create response is reconciled by looking the unique marker up **by directory** — not by `parentID`, which the pinned server drops, so a parent-scoped lookup would replay the create and duplicate the session. Completion is declared with markers parsed tolerantly from the last assistant reply: `<masterhand:goal status="complete|blocked">{…}</masterhand:goal>`, `<masterhand:critique>{…}</masterhand:critique>`, `<masterhand:verdict>{…}</masterhand:verdict>`; clients split the same blocks out of assistant text and render them as cards (never raw JSON).

Reliability (see `ARCHITECTURE.md` §4.11 and `docs/past-mistakes.md`):

- Every opencode call goes through the shared retry engine (ADR-32): idempotent calls retry transient failures (429/5xx/network) with incremental backoff; internal session creation and prompts reconcile their persisted marker first, so a retry can never duplicate them.
- opencode's own provider retries (`session.retry.scheduled`) only update the run note; a failed turn re-drives its phase up to 3 times (2s/4s/8s). A missing completion marker gets a single corrective prompt, then the run errors.
- A watchdog reconciles lost `session.idle` events (the awaited session is no longer active), `server.connected` refetches the run, and after a BFF restart in-flight runs become `paused` — never auto-resumed. Deleting the main session drops the run; deleting an awaited internal session fails it.
- Every transition is broadcast as a synthetic `goal.updated` frame on `/api/events` (same payload as `GET …/goal`), so clients never poll.

## Board (kanban, one per workspace)

Each workspace has one board: columns with ordered cards (`title` + `description`). The web Board section renders the selected workspace's board; switching workspaces switches boards with no extra selector beyond the existing workspace bar.

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/board?workspace=<id>` | `{ board: { workspaceID, columns: [{ id, title, position, cards: [...] }] } }` — cards nested and sorted by position. `400 workspace_required`, `404 workspace_not_found` |
| `POST` | `/api/board/columns` | Body `{ id, workspaceID, title, position? }` → `201 { column }`; idempotent by id (a replay returns the existing row, never overwrites an edit); position defaults to the end. `409 column_workspace_mismatch` when the id already lives in another workspace |
| `PATCH` | `/api/board/columns/:id` | Body `{ title?, position? }` → `{ column }`; a position change reindexes. `404 column_not_found` |
| `DELETE` | `/api/board/columns/:id` | `{ ok: true }`; deletes its cards in the same transaction; idempotent |
| `POST` | `/api/board/cards` | Body `{ id, columnID, title, description?, position? }` → `201 { card }`; idempotent by id. `404 column_not_found` |
| `PATCH` | `/api/board/cards/:id` | Body `{ title?, description?, columnID?, position? }` → `{ card }`; a move reindexes source + target in one transaction. `404 card_not_found` / `column_not_found`, `409 column_workspace_mismatch` when the target column belongs to another workspace (the card stays on its board) |
| `DELETE` | `/api/board/cards/:id` | `{ ok: true }`; idempotent |

Validation: bounded `id` (1–128 chars of `[A-Za-z0-9._-]`), non-empty bounded `title` (≤ 200), bounded `description` (≤ 10000), `position` integer ≥ 0. Errors: `400 invalid_*`, storage failures through the existing `503 storage_unavailable` ladder.

Reliability (see `ARCHITECTURE.md` §4.12 and `docs/past-mistakes.md`): every mutation is idempotent by design (absolute positions, client-generated ids with upsert creates, idempotent deletes), so a lost response is reconciled by a plain refetch/retry with no duplication. Every successful mutation publishes a synthetic **`board.updated`** frame through the existing hub (`{ workspaceID, board }`, the same full-snapshot shape as `GET`), exactly like `goal.updated`: no client polls, other devices stay in sync, reconnect reconciliation refetches (`invalidateOnReconnect` covers `["board"]`). Deleting a workspace drops its board rows; deleting a column drops its cards in one transaction.

## Scheduler (scheduled tasks)

The BFF owns a small task scheduler (`apps/server/src/scheduler.ts`, ADR-36): a single 20s tick (`setInterval`, unref'd) drives per-task serialized chains, and state lives in SQLite (`scheduled_tasks`/`scheduled_runs`, same database). A task = name + prompt + model (`{ providerID, id, variant? }`) + directory + schedule + timezone; the schedule is `{ kind: "interval" | "cron", intervalMinutes?, cron? }` — intervals must be ≥ 5 minutes, a 5-field cron expression is evaluated by `croner` (Intl-timezone support) and must keep at least a 5-minute gap between consecutive runs — and each task carries an explicit IANA timezone (empty = server default). Every fire creates a **new, normal opencode root session** in the task's directory, titled with the task name (it shows up like any workspace session), pins the stored model via `/api/session/:id/model` and sends the stored prompt with a metadata marker. Deleting a task cascades its runs but never the sessions it created; deleting a run's session (`session.deleted`) fails only that run.

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/scheduled-tasks` | `{ tasks: ScheduledTask[] }` — every task with its `nextRunAt`/`lastRunAt` |
| `POST` | `/api/scheduled-tasks` | `201 { task }`. Body: `{ name, prompt, model, schedule, directory, timezone? }`; `nextRunAt` is computed at create |
| `PATCH` | `/api/scheduled-tasks/:id` | `{ task }`. Body: any subset `{ name, prompt, model, schedule, directory, timezone, paused }` — edits and pause/resume. Only the provided fields are written, inside the task's serialized chain over a fresh read (a fire's `lastRunAt`/`nextRunAt` or a concurrent pause is never overwritten); a task deleted while the request validates answers `404 task_not_found` (never resurrected). An already-future `nextRunAt` is kept when the schedule still fits; resume recomputes it strictly in the future, so resuming late never fires at once |
| `DELETE` | `/api/scheduled-tasks/:id` | `{ ok: true }` — idempotent; drops the task, its runs (including a queued envelope) and nothing else |
| `POST` | `/api/scheduled-tasks/:id/run` | `202 { run }` — "Run now": a manual fire through the same serialized path (`source: "manual"`), otherwise identical to a scheduled fire. `409 task_paused` while paused, `404 task_not_found` |
| `GET` | `/api/scheduled-tasks/:id/runs` | `{ runs: ScheduledRun[] }` — newest first, cap 50 |

Validation at the trust boundary: non-empty `name` (≤ 200 chars), `prompt` (≤ 8000 chars) and `directory`, `model` as `{ providerID, id, variant? }` and a schedule validated left to right, answering `400` with `invalid_schedule`, `invalid_schedule_kind`, `invalid_interval` (interval < 5), `invalid_timezone` (unknown IANA zone), `invalid_cron` (missing/uncompilable/never-firing expression) or `invalid_frequency` (a cron firing more often than every 5 minutes); the task shapes answer `invalid_task`, `invalid_name`, `invalid_prompt`, `invalid_directory`, `invalid_model`. Unknown task ids answer `404 task_not_found`; storage failures through the existing `503 storage_unavailable` ladder.

Run state machine: `queued → firing → running → completed | failed`, with `interrupted` and `skipped` terminal records — at boot `firing → interrupted` and `queued → skipped` (never auto-resumed). Overlap policy is enqueue, never stack: a due fire while a run is active records exactly **one** coalesced `queued` run that fires right after the active run settles, and pausing/deleting the task meanwhile turns it `skipped`. `nextRunAt` always advances from the **scheduled** slot; missed slots are skipped silently — no catch-up, no records for them.

Reliability (see ADR-36 and `docs/past-mistakes.md`):

- Every transition (tick pass, opencode event, manual run) is serialized through a per-task in-flight chain, so two devices or a retry can never double-fire a task (rule 12); "Run now" goes through the same chain, so double taps coalesce into one run. Route patches go through `updateTask` on that same chain: only the changed fields are written over a fresh read, so an edit or pause cannot clobber a slot a fire just advanced (and a task deleted meanwhile is not resurrected).
- The fire path is non-idempotent and reuses ADR-32: run + markers are persisted **before** each mutation (`masterhand.scheduler` = `<taskId>#<runId>#create` / `#prompt`), the create reconciles by directory (the pinned opencode drops `parentID`), and an unresolved ambiguity marks the run `failed` — no blind retries, no destructively deleted sessions.
- `running` runs self-heal: each tick checks opencode's active sessions (goal-watchdog pattern) and settles the run `completed` when the session is idle; `session.idle`/`session.execution.succeeded` complete it, `session.execution.failed`/`session.error` fail it, and an outage leaves the run for a later tick instead of failing it.

Every transition publishes a synthetic **`scheduler.updated`** frame through the existing hub ({ `taskID` } — bare, like `goal.updated`/`board.updated`; there is no payload to write into the cache): clients invalidate their scheduler queries and refetch (SSE has no replay, so reconnect reconciliation refetches too). This extends FR-6: scheduled fires surface to every connected device through the frame plus the normal session notifications of the created session.

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
| as listed | `/api/oc/*` | Forwards the **allowlisted** method/path pairs (below) to `OPENCODE_URL` (e.g. `http://opencode:4096`) injecting `Authorization: Basic` with `OPENCODE_SERVER_PASSWORD`. The `/api/oc` prefix is removed: `/api/oc/api/model` → `GET /api/model`. Preserves method, body, query and `content-type` byte-for-byte on allowed routes (including the `location[directory]` query used to target a workspace). **Everything else answers `404 { error: "not_found" }` before an upstream call is made**, and encoded slashes (`%2f`) are refused. An opencode `401/403` is converted into `502 { error: "opencode_unauthorized" }` instead of being relayed (relaying it would sign the MasterHand user out). Bodies are capped at `PROXY_BODY_LIMIT_MB` (10 MiB default) and oversized ones answer `413 { error: "payload_too_large" }` before anything is buffered; malformed percent-encoding in a prompt path answers `400 { error: "invalid_path" }`. `502 opencode_unreachable` if opencode does not answer. `504 { error: "opencode_timeout" }` when the upstream stalls past the 60s proxy deadline (the clients abort sooner with their own request timeout). |

**Allowlist** (method-exact, applied after auth and `bodyLimit` and before this proxy reads the body; `bodyLimit` may answer `413` first for oversized bodies. Paths shown after the `/api/oc` prefix):

- `GET`: `/api/session/active`, `/api/session/{id}/message`, `/api/permission/request`, `/api/form`, `/api/session/{id}/form`, `/api/session/{id}/form/{formID}`, `/api/agent`, `/api/model`, `/api/model/default`, `/api/provider`, `/api/integration`, `/api/websearch/provider`.
- `POST`: `/api/session/{id}/{agent,model,prompt,command,fork,interrupt}`, `/api/session/{id}/permission/{requestID}/reply`, `/api/session/{id}/form/{formID}/reply`, `/api/integration/{id}/connect/key`, `/api/credential/{id}/activate`, `/api/websearch`.
- `DELETE`: `/api/session/{id}`, `/api/session/{id}/form/{formID}`, `/api/credential/{id}`.
- **Denied by omission** (not exhaustive): every PTY/terminal/shell route (`POST /api/pty`, `/api/shell*`, `/api/session/{id}/shell`), `/api/fs/*`, `/api/config`, `/api/plugin`, `/api/experimental/mcp`, `GET /api/credential` (also not available upstream in 2.0.6, #216), session create/list/get/patch, `/api/info`, `/api/event`, `/api/command` and `prompt_async`.
- The BFF's own `callOpencode` paths (session create/list, PTY/run control, instruction/permission writes, goal/scheduler, config reads) never traverse this proxy and are unaffected.
- This is a client-boundary control, not an engine sandbox: opencode's own read tools and project-level plugins run as the engine user. Residual risks are tracked in [#218](https://github.com/ToguDV/masterhand/issues/218) and [#219](https://github.com/ToguDV/masterhand/issues/219).

Transport hardening (shared with every internal call, ADR-32): `GET`/`HEAD` and the idempotent `agent`/`model` switches retry transient upstream statuses (429/5xx) and fast network failures with incremental backoff, and a `POST …/prompt` carrying the client's `masterhand.delivery` marker is retried too — after verifying through `GET /api/session/:id/message` that the marker did **not** already land, so a replay can never duplicate the turn. Mutations without a reconciliation marker (slash commands, permission/form replies, forks) stay single-shot; the client's own lost-response reconciliation covers them.

The same proxy carries the provider integration/credential endpoints behind Settings > Providers (issue #128), verified against the pinned opencode v2.0.6: `GET /api/oc/api/integration`, `POST /api/oc/api/integration/{id}/connect/key`, `POST /api/oc/api/credential/{id}/activate` and `DELETE /api/oc/api/credential/{id}`. **`GET /api/oc/api/credential` is not available in 2.0.6 (it answers `404`) and is not allowlisted; clients still call it, tracked as [#216](https://github.com/ToguDV/masterhand/issues/216), and the E2E mock implements it.** No dedicated BFF route exists: an API key transits client → BFF → opencode only, is stored in opencode's credential store (`opencode.db` in 2.0.6; there is no `auth.json`), and is never persisted or logged by MasterHand. The credential endpoints do not echo it; the separate `settings.apiKey` field in the provider/model catalogs is tracked in [#217](https://github.com/ToguDV/masterhand/issues/217). **#217:** `GET /api/provider` and `/api/model` include the upstream `settings.apiKey` field; treat both catalogs as secret-bearing until [#217](https://github.com/ToguDV/masterhand/issues/217) verifies/redacts it — never log, persist or echo them.

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
- The add dialog **loads the model list automatically**: once the base URL is valid, it debounces a `POST /api/providers/custom/models`, which calls `<baseURL>/models` on a 10 s budget and returns `{ id, name? }` entries (accepts the OpenAI `{ data }` shape, `{ models }` or a bare array; deduplicated, cap 200 — the same cap the config write enforces, so a discovered list can never be rejected as `invalid_models`). It is read-only and the transient key is only forwarded to the provider. There is **no manual model entry**: a failed discovery shows `This provider does not expose models.` and keeps Create disabled until the list loads (an auth failure is reported separately). Self-hosted installs commonly point the base URL at a **private LAN** address, so RFC 1918/ULA ranges are allowed; loopback, link-local/metadata, multicast and reserved targets are refused before the request (DNS names are resolved and every address is checked, so a name pointing at `169.254.169.254` is rejected too). This is SSRF hardening, not a full egress allowlist: DNS rebinding between the lookup and `fetch` and cross-origin redirects remain residual risks (ADR-37).
- opencode reloads the watched config dir, so `/api/model` and `/api/integration` pick the provider up without a restart; a custom provider then exposes a `key` method, and its connection state shows up in `GET /api/integration/{id}` (`GET /api/credential` is not available in 2.0.6, #216).

## Web search

opencode v2 ships five web search sources (**Exa, Firecrawl, Parallel, Tavily, TinyFish**), selected with its `websearch` config key (verified against the pinned **2.0.6**: `GET /api/websearch/provider` lists the sources and `POST /api/websearch` runs a search; each source also registers as an integration with a `key` method, so API keys connect through the same `connect/key` endpoint as providers). MasterHand stores the selection in the config file it already owns:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "websearch": { "provider": "tinyfish" },
  "providers": {}
}
```

- **Keyless default**: TinyFish works without an API key (opencode documents its `TINYFISH_API_KEY` as optional; Tavily also has a keyless fallback in the pinned build, but its key is documented as required). The BFF seeds `websearch.provider = "tinyfish"` at boot when the key is absent, and `GET /api/websearch` repeats the seed lazily (self-healing when the owned file is recreated under a running server). It never overrides a present value — a hand-edited one included — and a malformed file is never overwritten.
- **Why seed it**: without a selection opencode asks a form (`metadata.kind = "websearch.provider"`) before the first search; MasterHand clients only render `question` forms, so the agent's search would time out as "Web search cancelled". The seed makes agent web searches work out of the box.
- **Selection writes** are full-state replacements (atomic temp file + rename, serialized with the provider writes) and every other top-level key of the shared file is preserved; opencode watches the config dir, so the new source applies without a restart.
- **Keys stay in opencode**: each source is an integration (`exa`, `firecrawl`, `parallel`, `tavily`, `tinyfish`), so Settings > Web search connects/disconnects through `POST /api/oc/api/integration/{id}/connect/key` and `DELETE /api/oc/api/credential/{id}` — no dedicated BFF route, and MasterHand never stores a key.
- **Test probe**: `POST /api/oc/api/websearch` (opencode) runs one real search with the current selection; the UI shows the answering source or a mapped error. It is read-only.

Examples:

```bash
# create a session in a workspace (BFF route; session create/list are not proxied)
curl -X POST https://your-origin.example/api/workspaces/<workspaceID>/sessions \
  -H 'content-type: application/json' \
  -d '{"isolated":false}'
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
# native login (device token); installID is the stable per-installation identity
curl -X POST https://your-origin.example/api/devices \
  -H 'content-type: application/json' \
  -d '{"password":"...","name":"Pixel 9","installID":"6f1c2e9a-..."}'
```

## Error shapes

- Any uncaught route failure answers JSON instead of a bare 500: `500 { error: "internal_error" }` (method/path logged) or `503 { error: "storage_unavailable" }` when the failure is a SQLite error (disk full, read-only, corrupt). Route catch-alls rethrow storage failures before their typed mappings and before any rollback/cleanup, so a record that cannot be persisted answers `503` and never surfaces as `goal_failed`/`scheduler_failed`/`run_failed`/`preview_failed` or destroys a healthy worktree.
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
| `PROXY_BODY_LIMIT_MB` | `10` | Cap on `/api/oc/*` request bodies (1–1024 MB). Login/device bodies are fixed at 64 KiB; oversized requests answer `413 payload_too_large` |
| `MANAGED_RUN_LAUNCHER` | — (empty = native) | Compose sets it to `/usr/local/bin/agent-exec`: managed runs execute as `agent` (uid 1001) through `agent-exec --exec <command> <args>`, with a scrubbed environment and a validated `PORT`. Must be an absolute path inside the opencode container (≤ 256 chars, no control characters) or boot fails; empty/absent keeps the native behavior (runs inherit the user running `opencode serve`) |
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
