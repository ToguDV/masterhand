# Past mistakes — reliability edge cases to keep in mind

**Read this before adding or changing any operation that mutates server state** (sending a prompt, creating/deleting a session or workspace, answering a permission/form, starting/stopping the run or preview, finishing an isolated session, revoking a device, …).

PRs [#62](https://github.com/ToguDV/masterhand/pull/62) and [#63](https://github.com/ToguDV/masterhand/pull/63) fixed one family of failures in the web composer. The same root causes can reappear anywhere a client talks to the BFF/opencode over an unreliable transport. This document records them — and the rules they produced — so new code does not reintroduce them or repeat a class of mistake we already paid for.

**Every resolved issue must leave its failure class here** (see `WORKFLOW.md` §"Working from an issue"): a new/updated rule, checklist item or established pattern. A fix without that trace is not done.

## The failure family

| # | Root cause | Typical symptom |
|---|---|---|
| A | **Unbounded async operation** with no deadline | A `busy`/`sending` flag latches forever; the UI looks stuck until reload |
| B | **Optimistic state clobbering** during a slow operation | Text typed while sending is wiped when the (late) response arrives |
| C | **Lost/ambiguous response** on a non-idempotent mutation, with no second channel | False "could not …" after the server actually applied it; blind retry duplicates work |
| D | **Race between a timeout fallback and a late confirmation** | A confirmed success still surfaces a failure/warning |
| E | **Partial failure leaves a resource orphaned** | A forked session, spawned process or created record that no one tracks/removes |
| F | **Destructive cleanup acting on an unverified store** | Startup/background maintenance deletes valid records or uncommitted work while a volume was missing, stale or partially mounted |

## Rules

1. **Every request has a deadline.** All BFF/opencode calls go through `client-core`'s `request`/`authedFetch`, which apply `ClientOptions.timeoutMs` (default 30 s) and raise `RequestTimeoutError`. On the server, every internal opencode call is bounded too (`OPENCODE_TIMEOUT_MS`, default 10 s, normalized to `OpencodeTimeoutError` and answered `504 opencode_timeout`) and the public proxy keeps a 60 s budget: no BFF route may await an upstream promise forever. Never call `fetch` directly for server state, and never await a promise whose rejection can leave a flag set. `timeoutMs: 0` only for deliberately unbounded streams.
2. **A deadline that is too short for a legitimate operation is a bug.** Long operations (`finish` = commit + push + PR; run/preview readiness) need their own budget or a documented override, not the generic 30 s. Note the BFF proxy bounds upstream calls at 60 s; treat the client deadline as intentionally shorter for interactive calls.
3. **Only clear/overwrite local state that is still what you sent.** Compare against the value captured at submit time (web composer uses `textRef`); never blow away edits the user made while the request was in flight.
4. **Distinguish "timed out / unknown" from "failed".** A `RequestTimeoutError` means the operation **may have succeeded**. Show an ambiguity message, never a hard failure, and never auto-retry a non-idempotent mutation (prompts, create session, answer form/permission, start run/preview, PR creation).
5. **If a second channel can confirm the mutation, use it.** opencode events (`permission.replied`, `form.replied`, `session.*`) and the live history are reconciliation sources. On confirmation, treat the operation as success and suppress the pending error/warning. A late confirmation must beat an earlier timeout rejection.
6. **Bound and clean up partial failures.** Register created resources (fork id, PTY, record) as soon as they are known — before the follow-up request — so both the failure path and unmount cleanup can remove them. Do not leak a fork/spawn if the second step fails.
7. **Guard against double submit synchronously.** A React state flag is not a lock: two events in the same tick can both read it as `false`. Use a ref for in-flight guards on non-idempotent actions.
8. **Reconcile stale state.** When an entity is deleted/renamed elsewhere (`session.deleted`, workspace list change), clear references to it (open session, cached panels) instead of leaving a mounted view pointed at a 404.
9. **Bound polling of transitional states.** `starting`/`retry` polls need a cap/backoff and a timeout state; an unbounded 1.5 s refetch spins forever when the transition never completes.
10. **Correlate mutations with a server-persisted marker, not text + time.** Matching by text + time is fragile: identical consecutive sends, another device sending the same text, or server-side text normalization produce false positives (and false negatives). Prefer a correlation the server stores and returns verbatim — the prompt body accepts `metadata` and opencode persists it on the created user message, so MasterHand sends a per-send marker there (`delivery.ts`) and confirms only on it. When no marker channel exists, document the accepted residual risk with tests.
11. **Destructive cleanup only on a demonstrably healthy store.** Before deleting (or even moving) worktree records or folders, confirm the volume is real: the sentinel written by a previous successful pass, or live evidence that recorded paths still exist. When it cannot be confirmed — late/failed mount, DB restored from an older backup — skip the pass and log why. Prefer quarantine (rename, keep the branch) over delete, so uncommitted work stays recoverable, and never drop a record on a single `existsSync` observation alone.
12. **Serialize non-idempotent check→create on the server.** A client-side guard cannot stop two devices (or a retry racing the first request) from both passing a status check and creating two resources. Coalesce per entity with an in-flight promise (the architecture assumes a single BFF instance; see §4.6) and make stop/cleanup wait for it.
13. **Cap and observe the resources you share.** Unbounded container logs and memory are a full-disk/OOM incident waiting to happen when SQLite and the workspaces live on the same host: cap them (`LOG_MAX_SIZE`, `deploy.resources.limits`) and surface exhaustion (`/api/status.storage.low`) so the user acts before storage fails.
14. **Infrastructure failures degrade, never cascade.** Advisory writes (`touch`, audit) are best-effort and logged once; storage failures map to a typed `503 storage_unavailable` plus a status flag instead of opaque 500s; an expected constraint race maps to `409`/a retry; and a corrupt database fails loudly at boot with a restore pointer rather than serving broken requests.
15. **Never block the event loop with synchronous process or filesystem work.** `spawnSync`/`execSync`/`mkdirSync`/`rmSync` on request paths freeze the whole single-process BFF: SSE pings stop, clients lose events and every request queues behind a 60 s child deadline. Use async `spawn`/`fs/promises` behind an injectable runner for tests; a timed-out child is killed **as a process group** (SIGKILL to `-pid`) so hooks/credential helpers cannot keep its pipes open past the deadline.

## Checklist for a new mutating operation

- [ ] Request bounded by a deadline (or an explicit, justified override).
- [ ] Local `busy`/optimistic state is reset on **every** outcome (success, error, timeout, unmount).
- [ ] Text/inputs edited during the operation survive the response.
- [ ] Timeout surfaced as "unknown / may have succeeded", not a failure.
- [ ] A non-idempotent mutation is never auto-retried.
- [ ] If a confirmation channel exists, wire it and let it beat a later timeout.
- [ ] Created/partial resources are removed on failure and unmount.
- [ ] In-flight guard uses a ref, not state alone.
- [ ] Concurrent identical mutations coalesce server-side (no duplicate PTY, process or record).
- [ ] Resource growth (logs, memory) is bounded and exhaustion is surfaced to clients.
- [ ] Destructive cleanup paths confirm storage health first and quarantine rather than delete irreplaceable data.
- [ ] Tests cover: lost response, timeout, slow success, double submit, unmount mid-flight.

## Already-established patterns (reuse, don't reinvent)

- `client-core` `RequestTimeoutError` + `timeoutMs` (PR #62).
- BFF `fetchOpencode`/`OpencodeTimeoutError` + `OPENCODE_TIMEOUT_MS`: one bounded entry point for internal opencode calls, mapped to `504 opencode_timeout` (#75).
- Synchronous send lock in both composers: `inFlight`/`startingSideQuestionRef` refs, set before the first `await` (#72; `inFlight` also backs the pending-send ghost, #125).
- Web composer delivery reconciliation via `queryKeys.messages` and the per-send marker persisted in the prompt `metadata`: `createDeliveryMarker` / `deliveryMetadata` / `deliveryMarkerOf` in `client-core` (#71; replaces the PR #63 text + time heuristic).
- Worktree reconciliation volume gate + quarantine: `reconcileWorktrees` requires `VOLUME_SENTINEL` or a live recorded path before dropping records, and `manager.quarantine` renames orphan worktrees (branch kept, git admin pruned) instead of deleting them (#79).
- Reconnect reconciliation: `invalidateOnReconnect`, `syncPending` for permissions/forms, `server.connected`.
- Cache merge to avoid event/poll races: `mergeStatuses`, `mergeLiveMessages`, `reconcilePermissions`, `reconcileForms`.
- Event-hub stall watchdog: `parseSseStream`'s `onActivity` reports raw chunks (heartbeats/comments included), the hub aborts/reconnects past `stallMs` (opencode heartbeats every 15 s, default window 45 s) and pushes `hub.connected`/`hub.disconnected` downstream so clients refresh `/api/status` immediately (#76).
- SSE watchdog + reconnect (`createEventStream`) and the BFF heartbeat.
- Open-entity reconciliation by list diff: keep the ids of the previous list snapshot and close/replace the open entity only when it **was present before and disappeared** from a fresh fetch (web open session on `session.deleted`, #69). Never close on an absent id that was never seen: a just-created entity or a stale in-flight response must not be dropped.
- Bounded per-client SSE queue: `/api/events` writes through one serialized drain loop and drops a client that falls more than `MAX_SSE_QUEUE` frames behind, instead of forking an unbounded promise/string chain (#83).
- Terminal startup state: `/api/status` resolves the shell on **every** outcome — success → app, 401 → login, transport error → login + banner, any other HTTP error → retry screen (`statusFailed`) — so a 5xx can never leave "Loading…" forever (#81).
- Session-create reconciliation by marker: `createSession` sends `marker`, the BFF persists it as opencode session metadata (`masterhand.create`) and returns it from the list; on a timeout/504 the client walks the list (bounded: three attempts) and opens the marked session instead of reporting a failure (#66). No blind retry.
- Auto-accept retry: bounded attempts with backoff (`AUTO_ACCEPT_MAX_ATTEMPTS`/`AUTO_ACCEPT_RETRY_DELAYS_MS`, web + mobile), tracked per permission in a pending set that `permission.replied` clears; after the cap the session is never left silently blocked — the inline card plus an actionable banner let the user answer manually (#70).
- Coalesced non-idempotent starts: `RunManager.start` keeps a per-session in-flight promise, so two Start taps (or devices) share one PTY instead of racing into duplicate dev servers; `stop`/`forget` wait for the in-flight create before acting (#84).
- Out-of-band entity cleanup: the BFF hub treats `session.deleted` as authoritative and releases the session's managed resources (quick tunnel, PTY, reserved port, worktree record/branch) even when no route ran (#85). Startup reaps orphaned `cloudflared` PIDs recorded at spawn time, killing only PIDs still confirmed to be cloudflared (PID-reuse guard).
- Bounded transition + liveness polling: `transitionPollInterval` polls `starting` at 1.5 s up to `STARTING_TIMEOUT_MS` (then the UI shows a timeout) and `running` at 5 s so a run/tunnel that dies on its own flips to `stopped`/`error` with a visible notice instead of a stale "running" (#89, #73).
- Ambiguous answer reconciliation: `respondPermission`/`respondForm`/`cancelForm` treat `RequestTimeoutError`/504 as "may have applied", reconcile against `GET /permission` / `GET /form` before reporting, and only invite a retry when the request is provably still pending — with ref in-flight guards so a same-tick double click cannot double-answer (#67).
- Long-operation budget + record reconciliation: `finish` uses `FINISH_TIMEOUT_MS` (240 s) instead of the interactive deadline, reconciles a lost response against the isolated-session record (`finishResultFromIsolation`), and the server never re-creates a PR when `pr_url` is already recorded, so a retry is safe (#65).
- Degradation ladder: `app.onError` maps SQLite errors to `503 storage_unavailable` (everything else to a logged `500 internal_error`), advisory writes are wrapped and logged once, and `/api/status` carries `storage.ok`/`storage.low` for client banners (#86, #88). SQLite runs `quick_check` at boot, `VACUUM INTO` backs it up online (`npm run backup` / `dist/backup.js`, `docs/runbooks/backups.md`), and unexpected process failures log + exit deliberately (#80, #88).
- Async external work: `runGitCommand` + `spawnResult` (worktrees.ts) run every git/`gh`/`glab` call through `spawn` with a per-call timeout, process-group kill and an injectable runner; `createWorkspaceDir`/`removeWorkspaceDir` use `fs/promises` and `preview.available()` probes `cloudflared` without `spawnSync` (#77).
- Guarded branch mutations: `POST /workspaces/:id/branches` and `/checkout` validate the ref name, refuse while any workspace session is busy (fresh list vs `/api/session/active`, fail-closed `502 busy_check_failed`), reject a dirty tree on checkout (`409 dirty_worktree`) and answer a git deadline as `504 git_timeout` — the client (`branchErrorMessage`, `BRANCH_TIMEOUT_MS`) frames it as "may have applied", refetches the branch list and never auto-retries (#94).
- Mobile secure-storage resilience: bootstrap catches SecureStore failures (login screen with a storage-specific message, never a permanent spinner), login separates authentication from persistence (the session stays usable in memory with a banner when it cannot be saved) and `saveSessionPreferences` serializes its read-modify-write queue so concurrent saves cannot clobber each other, keeping the chain alive after a rejected write (#82).
- Pending-send ghost with marker reconciliation: `usePendingSend` (client-core) owns the plain-prompt state (`begin` on submit, `fail` on a hard error) and clears it only when the persisted history shows the send's marker; the composer releases when the ghost clears, so a lost response resolves without a deadline wait and the real bubble and ghost never coexist. Slash commands keep button-only feedback; an ambiguous timeout keeps reconciling and is never auto-retried (#125).
- Hermetic E2E scratch state: every Playwright run wipes and recreates its `DATA_DIR`/`WORKSPACES_ROOT`/die-file in a global setup and removes them in the teardown, and `reuseExistingServer` is always `false` — a killed run's servers or SQLite can never poison the next run silently (a busy port fails loudly instead). Scratch paths are plain constants in `e2e/paths.ts`: the config file is evaluated once per process (runner AND each worker), so clock/pid-derived values diverge between the process spawning the servers and the one running the specs. Locked by `scripts/e2e-harness.test.mjs`. `test:e2e` also frees both reserved ports (`e2e/cleanup-ports.mjs`: /proc scan, SIGTERM then SIGKILL) before Playwright boots, so a killed run's orphaned mock/BFF can never fail the next run with "port is already used".
- Provider credentials from settings: `connectIntegrationKey`/`removeCredential`/`activateCredential` go through the `/api/oc/*` passthrough; the UI shows an ambiguity message on a timeout (never auto-retry), refreshes the integration list to reconcile, and treats keys as write-only (never pre-filled, echoed, logged or stored client-side) (#128).
- Shared cross-platform token modules: color themes (`palettes.ts`: ids, labels, per-mode sets, paper fallback) and syntax highlighting (`highlight.ts`: path/fence detection, six token kinds) live in `client-core` as pure data/functions with one platform renderer each, so 13 themes × 2 modes and the token grammar cannot drift between CSS and native (#124, #123).
- Android system bars follow the app theme at runtime (`ThemedSystemBars` over `expo-navigation-bar`, best-effort and never-throwing); on forced edge-to-edge the bar is transparent and the themed canvas behind it does the visual work (#118).

## Open issues in this family

None open. The settings/chat/providers batch landed 2026-10-06 (#119–#122, #125–#128);
the remaining backlog is tracked in `docs/plans/issue-chunks.md`.
