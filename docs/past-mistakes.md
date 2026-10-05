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

## Checklist for a new mutating operation

- [ ] Request bounded by a deadline (or an explicit, justified override).
- [ ] Local `busy`/optimistic state is reset on **every** outcome (success, error, timeout, unmount).
- [ ] Text/inputs edited during the operation survive the response.
- [ ] Timeout surfaced as "unknown / may have succeeded", not a failure.
- [ ] A non-idempotent mutation is never auto-retried.
- [ ] If a confirmation channel exists, wire it and let it beat a later timeout.
- [ ] Created/partial resources are removed on failure and unmount.
- [ ] In-flight guard uses a ref, not state alone.
- [ ] Destructive cleanup paths confirm storage health first and quarantine rather than delete irreplaceable data.
- [ ] Tests cover: lost response, timeout, slow success, double submit, unmount mid-flight.

## Already-established patterns (reuse, don't reinvent)

- `client-core` `RequestTimeoutError` + `timeoutMs` (PR #62).
- BFF `fetchOpencode`/`OpencodeTimeoutError` + `OPENCODE_TIMEOUT_MS`: one bounded entry point for internal opencode calls, mapped to `504 opencode_timeout` (#75).
- Synchronous send lock in both composers: `pendingSend`/`startingSideQuestionRef` (web) and `sendLock` (mobile) refs, set before the first `await` (#72).
- Web composer delivery reconciliation via `queryKeys.messages` and the per-send marker persisted in the prompt `metadata`: `createDeliveryMarker` / `deliveryMetadata` / `deliveryMarkerOf` in `client-core` (#71; replaces the PR #63 text + time heuristic).
- Worktree reconciliation volume gate + quarantine: `reconcileWorktrees` requires `VOLUME_SENTINEL` or a live recorded path before dropping records, and `manager.quarantine` renames orphan worktrees (branch kept, git admin pruned) instead of deleting them (#79).
- Reconnect reconciliation: `invalidateOnReconnect`, `syncPending` for permissions/forms, `server.connected`.
- Cache merge to avoid event/poll races: `mergeStatuses`, `mergeLiveMessages`, `reconcilePermissions`, `reconcileForms`.
- Event-hub stall watchdog: `parseSseStream`'s `onActivity` reports raw chunks (heartbeats/comments included), the hub aborts/reconnects past `stallMs` (opencode heartbeats every 15 s, default window 45 s) and pushes `hub.connected`/`hub.disconnected` downstream so clients refresh `/api/status` immediately (#76).
- SSE watchdog + reconnect (`createEventStream`) and the BFF heartbeat.
- Open-entity reconciliation by list diff: keep the ids of the previous list snapshot and close/replace the open entity only when it **was present before and disappeared** from a fresh fetch (web open session on `session.deleted`, #69). Never close on an absent id that was never seen: a just-created entity or a stale in-flight response must not be dropped.

## Open issues in this family

| Issue | Area |
|---|---|
| [#65](https://github.com/ToguDV/masterhand/issues/65) | "Finish & PR" long non-idempotent operation |
| [#66](https://github.com/ToguDV/masterhand/issues/66) | Session creation recoverable after an ambiguous response |
| [#67](https://github.com/ToguDV/masterhand/issues/67) | Ambiguous permission/form responses and duplicate retries |
| [#69](https://github.com/ToguDV/masterhand/issues/69) | Open session not closed when deleted from another device |
| [#70](https://github.com/ToguDV/masterhand/issues/70) | Auto-accept permission stalls on failure |
| [#73](https://github.com/ToguDV/masterhand/issues/73) | Run/preview lifecycle ambiguity and bounded `starting` poll |

Track them with `gh issue list --label reliability`.
- Bounded per-client SSE queue: `/api/events` writes through one serialized drain loop and drops a client that falls more than `MAX_SSE_QUEUE` frames behind, instead of forking an unbounded promise/string chain (#83).
- Terminal startup state: `/api/status` resolves the shell on **every** outcome — success → app, 401 → login, transport error → login + banner, any other HTTP error → retry screen (`statusFailed`) — so a 5xx can never leave "Loading…" forever (#81).
