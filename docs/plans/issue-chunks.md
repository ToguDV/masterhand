# Issue chunks — batched follow-up plan

**Snapshot:** 2026-10-21. 27 open issues — the release/update work (#131, #133, #134), the
board and mobile-parity follow-ups (#164, #172), the C18 engine-side residuals (#216–#219) and the
remaining findings of the 2026-10-20 server audit — grouped into **5 pending chunks**
(C15–C16, C20–C22) by the code surface they share. C1–C14 and C17–C19 are merged or closed.

**Last updated:** 2026-10-21 — **C19 has landed (8/8)**: [#221](https://github.com/ToguDV/masterhand/pull/221)
merged #185–#189, #191, #193 and #195 (forward-only migrations with the v2 device install id,
timeout reconciliation by create marker, coalesced Finish & PR with provider lookup and monotonic
URL persistence, workspace-delete child release with a serialized scheduler pause, scheduler PATCH
inside the per-task chain, storage failures mapped to 503, conflict-safe preview port allocation).
Two review rounds added lifecycle hardening: a single-flight release map shared by session DELETE,
the `session.deleted` event and workspace deletion; `preview.forget` awaits an in-flight tunnel
start; refused deletes resume the tasks they paused; delete-vs-create is closed by removing the
workspace row first and re-reading it before persisting. Gates on the final commit: typecheck,
1.424 unit/integration tests with coverage, 34 script tests, 103 E2E and the production build.
Residuals are recorded in the C19 section below.

**Previous note:** 2026-10-20 — **C18 landed (9/9)**: [#214](https://github.com/ToguDV/masterhand/pull/214)
merged #178, #180–#184, #209 and #210 (git env/config sandbox, bounded bodies, failure-only
limiter, owner-only storage, strict boot config, provider target guard, path/ref and scheduler
validation); the session batch ([#220](https://github.com/ToguDV/masterhand/pull/220), #179) closed the last item — managed runs drop to `agent` through
`agent-exec --exec`, `/api/oc/*` is a method-exact allowlist, and engine credentials/config/log are
owner-only, verified at runtime on the dev stack. Residual follow-ups: #216–#219.
Re-chunked after the **server audit** (security, correctness,
performance/memory and tech debt): 35 issues, #178–#212, grouped into C18–C22.

**Previous note:** 2026-10-17 — **C17 landed** (scheduler, #147, on `feat/scheduler`): BFF
scheduler module + routes, `client-core` contract/queries and the web sidebar; mobile parity is
tracked in #172. The 2026-10-09 note recorded C14 merged (goal mode, #129 + #130, PR #148) with
the shared opencode retry engine it relies on (ADR-32). Stale trackers already shipped in #135
(#120, #122, #125–#128) were closed as completed; #121 was closed as not planned (sign-out stays
in the sessions options box per #136/#137).

## How to use this document

- A chunk is a **queue of independent issues**. `WORKFLOW.md` §1 now applies per **session**, not
  per issue: reproduce first, red test first, `docs/past-mistakes.md` trace, full gates, and every
  issue the session resolves ships in **one branch and one PR** (one commit per issue with its own
  red → green evidence).
- Batching is the maintainer's explicit preference (2026-10-05): the earlier one-PR-per-issue rule
  produced 8 concurrent PRs in a single session and repeated conflicts on the shared docs
  (`PROGRESS.md`, `docs/past-mistakes.md`) plus CI/up-to-date churn. Coupled pairs (e.g. #71+#72,
  #79+#77) no longer need separate approval — the whole session batch goes together.
- Reproduce before implementing (`WORKFLOW.md` §"Working from an issue"): an issue may be stale,
  already fixed or misdiagnosed. Close/relabel what does not reproduce.
- Update the status table when a chunk lands, and remove the issue rows from the open-findings
  table in `docs/past-mistakes.md` as each issue closes.

## Status

| Chunk | Issues | Status |
|---|---|---|
| C1 — Composer send hardening (web + mobile) | #72 #71 #64 #68 | ✅ Merged 2026-10-05 — #101 → #102 → #103 → #104 → #105 |
| C2 — Web session, permission and mutation lifecycle | #81 #69 #66 #67 #70 #65 | ✅ Merged 2026-10-05 — #81 #69 #66 #70 (#111–#114); #67 #65 in the lifecycle session batch (#116) |
| C3 — Run/preview lifecycle (client + server) | #73 #89 #84 #85 | ✅ Merged 2026-10-05 — lifecycle session batch (#116) |
| C4 — BFF transport (opencode calls + SSE hub) | #75 #76 #83 | ✅ Merged 2026-10-05 — #108 → #109 → #110 |
| C5 — Storage and process resilience (BFF) | #88 #86 #87 #80 #91 | ✅ Merged 2026-10-05 — lifecycle session batch (#116) |
| C6 — Worktrees and git | #79 #77 #94 | ✅ Merged 2026-10-05 — #79 (#107); #77 #94 in the remaining-issues session batch |
| C7 — Deploy/ops | #78 #90 | ✅ Merged 2026-10-05 — interleaved in the lifecycle session batch (#116) |
| C8 — Web unified run/preview panel + bubble | #97 #98 | ✅ Merged 2026-10-05 — remaining-issues session batch |
| C9 — Mobile ink-on-paper and parity | #82 #93 #100 #92 #99 | ✅ Merged 2026-10-05 — remaining-issues session batch |
| C10 — Settings hub and header cleanup | #119 #120 #121 #122 | ✅ 2026-10-06 — session batch (settings/chat/providers) |
| C11 — Theme system (palettes, syntax, system bars) | #118 #124 #123 | ✅ 2026-10-07 — theme-system session batch |
| C12 — Chat feedback and stats | #127 #126 #125 | ✅ 2026-10-06 — session batch (settings/chat/providers) |
| C13 — Provider credentials in settings | #128 | ✅ 2026-10-06 — session batch (settings/chat/providers) |
| C14 — /goal (server + clients) | #129 #130 | ✅ Merged 2026-10-09 — session batch (goal mode + shared retry engine) |
| C17 — Scheduler (web + client-core + BFF) | #147 | ✅ 2026-10-17 — session batch (scheduler; mobile parity deferred to a follow-up issue) |
| C15 — Releases and in-app updates | #131 #133 | ⬜ Pending — #186 landed; add v3+ migrations |
| C16 — Standardized BFF updater (deferred) | #134 | ⬜ Pending |
| C18 — Security boundary and input hardening (BFF) | #178 #179 #180 #181 #182 #183 #184 #209 #210 | ✅ 2026-10-20 (all 9) — #214 merged 8/9 (#178 #180–#184 #209 #210); #179 in [#220](https://github.com/ToguDV/masterhand/pull/220); engine-side residuals #216–#219 resolved 2026-10-28 (session batch, PR pending) |
| C19 — Persistence and mutation integrity | #185 #186 #187 #188 #189 #191 #193 #195 | ✅ Merged 2026-10-21 — [#221](https://github.com/ToguDV/masterhand/pull/221) (8/8 + review hardening) |
| C20 — Long-operation and shutdown reliability | #192 #194 #204 #208 | 🟡 Implemented 2026-10-28 on `fix/c20-shutdown-reliability` (4 commits, one per issue) — pending reviewer pass, PR not yet opened |
| C21 — Transport, memory and growth | #190 #196 #197 #198 #199 #200 #201 #202 #203 #211 | ⬜ Pending |
| C22 — Architecture and test debt | #205 #206 #207 #212 | ⬜ Pending |

**All previous chunks (C1–C9) are closed**: the remaining-issues session batch finished C6
([#77](https://github.com/ToguDV/masterhand/issues/77) async git runner,
[#94](https://github.com/ToguDV/masterhand/issues/94) branch picker), C8
([#98](https://github.com/ToguDV/masterhand/issues/98) bubble,
[#97](https://github.com/ToguDV/masterhand/issues/97) unified Run & preview panel) and C9
([#82](https://github.com/ToguDV/masterhand/issues/82),
[#93](https://github.com/ToguDV/masterhand/issues/93),
[#100](https://github.com/ToguDV/masterhand/issues/100),
[#92](https://github.com/ToguDV/masterhand/issues/92),
[#99](https://github.com/ToguDV/masterhand/issues/99)), all in PR #117.

**Highest severity in the queue:** the P1 pair **#185** (a create timeout deleted the worktree the
client still had to reconcile) and **#186** (no SQLite migration runner) was fixed by C19,
merged as [#221](https://github.com/ToguDV/masterhand/pull/221). The suggested batch order is now
**C20 → C21 → C22 → C15 → C16**. #186 unblocks C15 (new compatibility changes append v3+
migrations; v1/v2 are immutable); C16 stays deferred (opt-in).

## Chunks — audit batch (C18–C22)

### C18 — Security boundary and input hardening (BFF)

- **Issues:** [#178](https://github.com/ToguDV/masterhand/issues/178) sanitize git env/disable
  repo-controlled hooks (P0), [#179](https://github.com/ToguDV/masterhand/issues/179) run managed
  processes as `agent` and restrict `/api/oc/*`, [#180](https://github.com/ToguDV/masterhand/issues/180)
  body limits, [#181](https://github.com/ToguDV/masterhand/issues/181) login limiter,
  [#182](https://github.com/ToguDV/masterhand/issues/182) data/DB file modes,
  [#183](https://github.com/ToguDV/masterhand/issues/183) secret/boolean config validation,
  [#184](https://github.com/ToguDV/masterhand/issues/184) link-local provider discovery,
  [#209](https://github.com/ToguDV/masterhand/issues/209) proxy decoding and `baseRef` validation,
  [#210](https://github.com/ToguDV/masterhand/issues/210) scheduler input lengths.
- **Surface:** `apps/server/src/worktrees.ts`, `runs.ts`, `proxy.ts`, `app.ts` (auth routes and
  `/api/oc/*`), `config.ts`, `scheduler.ts` validation; `deploy/server.Dockerfile`,
  `deploy/opencode.Dockerfile`, `deploy/docker-compose.yml`, `deploy/agent-exec.c`.
- **Why together:** all cross a trust boundary in the same request/process path. #178/#179/#209
  touch the same git/proxy surface, and #180/#181/#183 are the same auth entry path, so one
  threat-model review covers the batch.
- **Order:** #178 → #179 → #183 → #181 → #180 → #182 → #184 → #209 → #210.
- **Dependencies:** #178/#179 before #209 (same files; #209 is the small hardening pass); #210
  reuses the validation conventions settled in #181. #182/#183 are independent.
- **Notes:** the #179 runtime verification landed with the session batch: managed run uid 1001/gid
  1000 with no supplementary groups, an allowlisted env and no `OPENCODE_SERVER_PASSWORD`, the
  DB/config/log unreadable to the agent, PTY proxy `404` vs model `200`, and
  `deploy/agent-exec-drill.sh` green. Every fix records its failure class in `docs/past-mistakes.md`
  (rules 13/15/22 and the security section). Residual catalog/credential behavior is tracked in
  #216–#219 (catalog/credential drift and engine-side tool/plugin residuals).
- **Status:** 4/4 residuals resolved 2026-10-28 in the C18-residuals session batch (one branch, one
  commit per issue, #219 → #218 → #217 → #216): #219 appends `engineReadGuardRules()` (`read` +
  `external_directory` denies on `/proc` and the engine data/config dirs) to the session permission
  PATCH — verified against the 2.0.6 source (`read` asserts the path, `grep`/`glob` assert the
  pattern and gate the path through `external_directory`; last-match-wins); #218 sets
  `OPENCODE_CONFIG_PROJECT_DISABLE=true` on the opencode service (plus the native `dev.mjs`
  default) — verified in the 2.0.6 source and at runtime (a marker plugin executed without the
  flag, never loaded with it); #217 deep-strips apiKey-like keys from the proxied
  `/api/model{,/default}` + `/api/provider` responses — verified live (a custom provider's
  `settings.apiKey` echoed verbatim); #216 derives `client.api.credentials()` from the
  allowlisted `GET /api/integration` connections and drops the mock's `GET /api/credential`, so
  the suite is exactly as strict as the pinned 2.0.6 (which 404s that route).

### C19 — Persistence and mutation integrity

- **Issues:** [#185](https://github.com/ToguDV/masterhand/issues/185) reconcile isolated sessions on
  timeout, [#186](https://github.com/ToguDV/masterhand/issues/186) forward-only SQLite migrations,
  [#187](https://github.com/ToguDV/masterhand/issues/187) coalesce Finish & PR,
  [#188](https://github.com/ToguDV/masterhand/issues/188) workspace delete cleanup,
  [#189](https://github.com/ToguDV/masterhand/issues/189) scheduler PATCH inside the chain,
  [#191](https://github.com/ToguDV/masterhand/issues/191) storage errors mapped to 503,
  [#193](https://github.com/ToguDV/masterhand/issues/193) device install id,
  [#195](https://github.com/ToguDV/masterhand/issues/195) preview port conflicts.
- **Surface:** `apps/server/src/app.ts` (isolated/finish/workspace/scheduler routes), `goal.ts`,
  `scheduler.ts`, `store.ts` (schema + queries), `preview.ts`; `packages/client-core` device
  registration; `apps/mobile/App.tsx`.
- **Why together:** all are read-modify-write or lifecycle bugs over the same SQLite store and the
  same isolated-session/device records; #186 is the prerequisite for #193's new column and for
  C15's compatibility requirement.
- **Order:** #186 → #193 → #185 → #187 → #188 → #189 → #191 → #195.
- **Dependencies:** #186 blocks #193 and C15; #185/#187 share the isolated-session record; #188
  touches the scheduler deletion path used by #189.
- **Notes:** the #186 test creates a v1 file, opens it with the new code and asserts both the
  upgrade and the data; #193 added the coordinated mobile change (a persisted install id under its
  own SecureStore key). **Migration contract from here:** v1 (baseline) and v2 (`install_id`) are
  immutable; every later compatibility change appends a new version (C15 starts at v3).
- **Status:** 8/8 merged in [#221](https://github.com/ToguDV/masterhand/pull/221), with two review
  rounds (single-flight release map, preview start/forget, pause-before-guard and task resume,
  delete-vs-create ordering, retryable session cleanup, deterministic race tests).
- **Residuals for follow-ups:** `worktrees.remove` is git-status-silent, so a branch/directory it
  fails to drop is logged but not retried; base-folder session release on workspace delete is
  sequential (O(N) upstream calls) and best effort when opencode is unreachable; the destructive
  delete removes the workspace row before the folder, so a `removeDir` failure leaves files
  without a registration; a crash between `pauseTask` and the response leaves tasks paused (no
  cross-request pause refcount); old mobile clients without `installID` keep the documented
  new-row-per-login fallback; a no-marker timeout after the workspace row vanished quarantines the
  worktree, but an upstream session created without a marker stays unknown.

### C20 — Long-operation and shutdown reliability

- **Issues:** [#192](https://github.com/ToguDV/masterhand/issues/192) close HTTP before the store,
  [#194](https://github.com/ToguDV/masterhand/issues/194) provider key budget,
  [#204](https://github.com/ToguDV/masterhand/issues/204) finish/delete operation deadlines,
  [#208](https://github.com/ToguDV/masterhand/issues/208) single-instance lock.
- **Surface:** `apps/server/src/index.ts` (boot/shutdown), `app.ts` (finish and workspace delete),
  `providers.ts`, `store.ts` (data-dir lock).
- **Why together:** all answer "the process or request must end predictably": bounded budgets,
  ordered shutdown and a refused second instance.
- **Order:** #192 → #194 → #204 → #208.
- **Dependencies:** #204 reuses the record reconciliation from #65/#187; #208 uses the DB path
  established by #186.
- **Notes:** test shutdown with an in-flight write; never trade the bounded budget for a longer
  client deadline.
- **Status:** 4/4 implemented 2026-10-28 on `fix/c20-shutdown-reliability` (#192 → #194 → #204 → #208,
  one commit per issue with red → green evidence each): ordered/bounded shutdown with goal drain
  (`shutdown.ts`), whole-loop connect-key budget, finish/delete operation budgets with abort threaded
  into git plus ambiguous 504s, and the single-instance data-dir lock. Pending reviewer pass; PR not
  yet opened.

### C21 — Transport, memory and growth

- **Issues:** [#190](https://github.com/ToguDV/masterhand/issues/190) SSE teardown on write failure,
  [#196](https://github.com/ToguDV/masterhand/issues/196) SSE byte budget,
  [#197](https://github.com/ToguDV/masterhand/issues/197) session pagination + scheduler retention,
  [#198](https://github.com/ToguDV/masterhand/issues/198) scheduled-run history limit,
  [#199](https://github.com/ToguDV/masterhand/issues/199) listen before reconciliation,
  [#200](https://github.com/ToguDV/masterhand/issues/200) remove sync fs from request paths,
  [#201](https://github.com/ToguDV/masterhand/issues/201) goal-role projections,
  [#202](https://github.com/ToguDV/masterhand/issues/202) overlapping periodic passes,
  [#203](https://github.com/ToguDV/masterhand/issues/203) audit index + retention,
  [#211](https://github.com/ToguDV/masterhand/issues/211) board snapshot N+1.
- **Surface:** `app.ts` (SSE writer, sessions/status routes), `events.ts`, `store.ts` (queries +
  indexes), `goal.ts`, `scheduler.ts`, `index.ts`.
- **Why together:** unbounded reads and event-loop stalls on the read/poll paths. #190/#196 are the
  same SSE writer; #197/#198/#203/#211 are all "add a LIMIT/index/retention to a hot read"; #199
  and #200 are boot/request blocking.
- **Order:** #190 → #196 → #203 → #198 → #197 → #199 → #200 → #201 → #202 → #211.
- **Dependencies:** #196 before raising the BFF memory limit; #211 feeds the same SSE queue, so
  after #196; #197 changes the sessions contract and must update web + mobile in the same session.
- **Notes:** #197 is the largest (contract + two clients); split the client work if the session
  grows. Measure the SSE byte budget with a slow-client test, not by inspection.

### C22 — Architecture and test debt

- **Issues:** [#205](https://github.com/ToguDV/masterhand/issues/205) extract opencode adapters,
  [#206](https://github.com/ToguDV/masterhand/issues/206) project the goal-run contract,
  [#207](https://github.com/ToguDV/masterhand/issues/207) route tests on in-memory SQLite,
  [#212](https://github.com/ToguDV/masterhand/issues/212) dead worktree helpers + cron catch-up.
- **Surface:** `app.ts`, `goal.ts`, `scheduler.ts`, `store.ts`, `worktrees.ts`,
  `packages/client-core` goal contract and tests.
- **Why together:** refactors that unblock the next features and remove duplicate sources of truth;
  #207 makes the schema work from C19 and the adapters from #205 safe to change.
- **Order:** #207 → #205 → #206 → #212.
- **Dependencies:** #205 before #206 (the adapter is the natural projection point); #212 is
  independent.
- **Notes:** no behavior change; keep the suite green and do not mix them into a C19/C21 session.

## Chunks — earlier queue (C10–C17)

### C10 — Settings hub and header cleanup (web + mobile)

- **Issues:** [#119](https://github.com/ToguDV/masterhand/issues/119) settings panel behind a gear
  icon, [#121](https://github.com/ToguDV/masterhand/issues/121) sign out into settings,
  [#122](https://github.com/ToguDV/masterhand/issues/122) mobile `+` next to the Sessions title,
  [#120](https://github.com/ToguDV/masterhand/issues/120) play icon for the Run & preview trigger.
- **Surface:** `apps/web/src/App.tsx` (top bar/overflow), `apps/web/src/components/SidePanel.tsx`,
  `ThemeToggle.tsx`, `RunPreviewPanel.tsx`, `icons.tsx`; `apps/mobile/src/screens/SessionsScreen.tsx`
  and `ChatScreen.tsx`, `components/NewSessionMenu.tsx`/`ThemeToggle.tsx`/`icons.tsx`,
  `apps/mobile/App.tsx`, `src/storage.ts`; `design/DESIGN.md`.
- **Why together:** one chrome change — the top bar and mobile headers lose the theme toggle and
  sign out, gain the settings gear, and the two small affordances (#120, #122) touch the same
  headers.
- **Order:** #119 → #121 → #122 → #120 (#120 is independent; landing it last avoids top-bar
  conflicts).
- **Dependencies:** #121 and #122 depend on #119 (recorded as prerequisites in the issues); #120
  none. **C10 unblocks #124, #128 and #130**, so it should land first.
- **Notes:** keep the settings panel structured so the other chunks append sections (themes,
  providers, goal review) without rework.

### C11 — Theme system: palettes, syntax colors, Android system bars

- **Issues:** [#118](https://github.com/ToguDV/masterhand/issues/118) Android nav bar stays white in
  dark theme, [#124](https://github.com/ToguDV/masterhand/issues/124) 12+ selectable color themes,
  [#123](https://github.com/ToguDV/masterhand/issues/123) syntax highlighting for tool cards and
  messages.
- **Surface:** `apps/web/src/styles.css` + `index.html` (pre-paint script) + theme persistence,
  `design/DESIGN.md`/`DESIGN.html`/`design.css`; `apps/mobile/src/theme.ts`, `App.tsx`,
  `components/Screen.tsx`, `app.json`; web/mobile `tools/ToolBodies.tsx`, `MessageContent.tsx`,
  `MessageBubble.tsx`.
- **Why together:** all three change the same token/palette system on both platforms — #124 adds
  the palette dimension, #123 derives syntax colors from it, #118 makes the native Android chrome
  follow the same theme resolution; one context avoids double-touching `theme.ts`/`styles.css`.
- **Order:** #118 (bug first, standalone) → #124 (palette architecture + settings picker) → #123
  (syntax colors on top).
- **Dependencies:** #124 needs #119 (settings section); #123 coordinates with #124 for contrast on
  every code surface; #118 none.

### C12 — Chat feedback and stats

- **Issues:** [#127](https://github.com/ToguDV/masterhand/issues/127) tok/s raw decimals (bug),
  [#126](https://github.com/ToguDV/masterhand/issues/126) compact per-message stats with icons,
  [#125](https://github.com/ToguDV/masterhand/issues/125) "Sending…" ghost bubble.
- **Surface:** `packages/client-core/src/chat.ts` (+ tests); web `MessageContent.tsx`, `ChatView.tsx`,
  `Composer.tsx`; mobile `MessageBubble.tsx`, `ChatScreen.tsx`, `Composer.tsx`; E2E mock
  (delayed-echo control) and specs.
- **Why together:** the same message-presentation/chat-state surfaces; #126 reuses the formatter
  fixed in #127 and #125 lifts the composer's pending-send state into the same chat containers.
- **Order:** #127 (quick bug; defines the integer speed formatter) → #126 (uses it) → #125
  (largest).
- **Dependencies:** #126 on #127; none on C10/C11.

### C13 — Provider credentials in settings

- **Issues:** [#128](https://github.com/ToguDV/masterhand/issues/128) manage provider credentials
  (OpenCode Go and the catalog) from settings.
- **Surface:** `packages/client-core/src/client.ts`/`hooks.ts` (integrations + credentials), the
  settings Providers section (web + mobile), E2E mock (`/api/integration`, connect-key),
  `docs/bff/api.md`.
- **Why together:** one issue, no BFF route expected (the `/api/oc/*` passthrough is verified in the
  issue); re-verify the endpoints against the pinned opencode OpenAPI while implementing.
- **Order:** #128 only.
- **Dependencies:** #119 (settings panel), so after C10.

### C14 — /goal: adversarial review loop

- **Issues:** [#129](https://github.com/ToguDV/masterhand/issues/129) BFF orchestrator with critic
  and judge, [#130](https://github.com/ToguDV/masterhand/issues/130) `/goal` command, run status UI
  and judge/critic settings.
- **Surface:** `apps/server/src/app.ts` + new goal module(s)/prompts, `store.ts`, `events.ts`;
  `packages/client-core` (goal API, hooks, command registration); web/mobile composer, status UI and
  settings; E2E mock (three roles); `docs/bff/api.md`, `ARCHITECTURE.md` (ADR),
  `docs/past-mistakes.md`.
- **Why together:** one feature split only for reviewability; the client contract derives from the
  server state machine.
- **Order:** #129 first (freeze the protocol/API contract) → #130 (UI + settings; can start against
  the frozen contract/mock).
- **Dependencies:** #130 needs #129 and #119; #129 none. Expected to be the largest session of the
  batch — budget for reconciliation and a `docs/past-mistakes.md` trace.

### C17 — Scheduler: recurring scheduled tasks (web + client-core + BFF)

- **Issues:** [#147](https://github.com/ToguDV/masterhand/issues/147) cron-like recurring tasks —
  BFF scheduler manager, `client-core` queries and the web sidebar (one issue; split across the three
  surfaces for the session batch).
- **Surface:** `apps/server/src/scheduler.ts` (new module: 20s tick, per-task serialization, boot
  reconciliation) + `store.ts` (`scheduled_tasks`/`scheduled_runs`) + route wiring;
  `packages/client-core` (`scheduler.ts` contract, client + hooks, `scheduler.updated` frame);
  web scheduler section in the left sidebar (create/edit, history, pause/resume, run-now);
  `docs/bff/api.md`, `ARCHITECTURE.md` (ADR-36), `docs/past-mistakes.md`.
- **Why together:** one feature; the client contract derives from the server state machine and the
  `scheduler.updated` frame shape (same pattern as C14).
- **Order:** BFF manager + contract first (freeze the routes/error codes) → `client-core` queries and
  hooks → web sidebar (can start against the frozen contract/mock).
- **Dependencies:** none on C15/C16 (independent surfaces). **Mobile parity is tracked in
  [#172](https://github.com/ToguDV/masterhand/issues/172)** — a new client must port the mutation
  contracts, not reimplement them (see `docs/past-mistakes.md`).

### C15 — Releases and in-app updates

- **Issues:** [#131](https://github.com/ToguDV/masterhand/issues/131) A — versioning, GHCR images
  and the BFF update check (web/desktop), [#133](https://github.com/ToguDV/masterhand/issues/133)
  B — self-hosted F-Droid repo and Android update notice.
- **Surface:** root/workspace `package.json` + `apps/mobile/app.json` (versioning);
  `.github/workflows/release.yml` (new: GHCR + `version.json` + release assets + F-Droid repo);
  `apps/server/src/app.ts` (`/api/status` + new `/api/update`) and `store.ts` (forward-only
  migrations for backward compatibility); `packages/client-core` (`BffStatus` + the update API);
  web/desktop update notice and `electron-updater` once packaging lands; the `fdroid` branch (repo
  index + APK) and the Android notice + Settings > About; `deploy/docker-compose.yml` (image vs
  build), `deploy/.env.example`, `docs/bff/api.md`, `docs/runbooks/deployment.md` +
  `docs/runbooks/fdroid.md` (new).
- **Why together:** one cross-platform feature with a single source of truth (`version.json` on
  GitHub Releases); the web reload, the Electron updater and the Android notice all read the same
  manifest through the same BFF endpoint, and #133 builds on the versioning/`versionCode` from
  #131.
- **Order:** #131 first (foundation + web/desktop + About) → #133 (F-Droid repo + Android notice,
  needs the versioning and the signed Android build). Both need #119 for the About section.
- **Dependencies:** #131 → #119 for the About UI, desktop packaging (Phase 4 pending) for
  `electron-updater`; #133 → #131 and #119. Backward compatibility is a first-class requirement:
  additive APIs, a tolerant `version.json`, forward-only SQLite migrations, a stable F-Droid
  signing key/URL and a non-decreasing `versionCode`.

### C16 — Standardized BFF updater (deferred)

- **Issues:** [#134](https://github.com/ToguDV/masterhand/issues/134) standardized one-click BFF
  updater (opt-in sidecar over GHCR).
- **Surface:** `deploy/docker-compose.yml` (opt-in profile: scoped Watchtower or a minimal
  privileged sidecar), `deploy/.env.example`, a BFF trigger endpoint, Settings > About UI state,
  `docs/runbooks/deployment.md`, `docs/past-mistakes.md`.
- **Why together:** one issue; deliberately deferred — v1 (#131) keeps the BFF update manual
  (`docker compose pull && up -d`) and only notifies.
- **Order:** after #131 (needs GHCR images + `/api/update`).
- **Dependencies:** #131. Never mount `/var/run/docker.sock` into the BFF; Docker access stays in
  the isolated sidecar.

## Previous batch — C1–C9 (all merged)

### C1 — Composer send hardening (web + mobile)

- **Issues:** [#72](https://github.com/ToguDV/masterhand/issues/72) double submit,
  [#71](https://github.com/ToguDV/masterhand/issues/71) delivery-match false positives,
  [#64](https://github.com/ToguDV/masterhand/issues/64) mobile composer parity,
  [#68](https://github.com/ToguDV/masterhand/issues/68) orphaned `/btw` forks.
- **Surface:** `apps/web/src/components/Composer.tsx`, `apps/mobile/src/components/Composer.tsx`
  (+ `SideQuestionPanel`), `packages/client-core` (prompt input/`ChatMessage` metadata), `e2e/mock-opencode.ts`.
- **Why together:** #71/#72 harden the same `send`; #64 is the mobile port of those rules; #68 is
  the fork lifecycle both composers share.
- **Order:** #72 → #71 → #64 → #68.
- **Dependencies:** #64 was a listed prerequisite of #92, #93, #99 and #100 — C1 landed, so the
  mobile track is unblocked.
- **Notes:** a prompt accepts `metadata` (`SessionPromptInput` in `types.generated.ts`) and the
  persisted `SessionMessageUser` keeps it, so a per-send marker is available; prefer it over the
  text+time heuristic (see #71).

### C2 — Web session, permission and mutation lifecycle

- **Issues:** [#81](https://github.com/ToguDV/masterhand/issues/81) status 5xx infinite loading,
  [#69](https://github.com/ToguDV/masterhand/issues/69) close the session deleted elsewhere,
  [#66](https://github.com/ToguDV/masterhand/issues/66) recoverable session creation,
  [#67](https://github.com/ToguDV/masterhand/issues/67) ambiguous permission/form responses,
  [#70](https://github.com/ToguDV/masterhand/issues/70) auto-accept retry,
  [#65](https://github.com/ToguDV/masterhand/issues/65) "Finish & PR" reconciliation.
- **Surface:** `apps/web/src/App.tsx`, `ChatView.tsx` (`finish`), `packages/client-core/src/hooks.ts`
  (`useBffStatus`, `session.deleted`), server finish route.
- **Why together:** all are the same ambiguous-mutation/reconciliation family (rules C–E in
  `docs/past-mistakes.md`) driven from the same `App` state.
- **Order:** ~~#81 → #69 → #66 → #70~~ (merged 2026-10-05) → #67 → #65.
- **Dependencies:** satisfied — [#75](https://github.com/ToguDV/masterhand/issues/75) (C4) landed,
  so #65 can rely on the server's bounded budget (`OPENCODE_TIMEOUT_MS`) plus its own long-operation
  client deadline.

### C3 — Run/preview lifecycle (client + server)

- **Issues:** [#73](https://github.com/ToguDV/masterhand/issues/73) lost responses and unbounded
  `starting` poll, [#89](https://github.com/ToguDV/masterhand/issues/89) surface a run/preview that
  dies, [#84](https://github.com/ToguDV/masterhand/issues/84) duplicate PTYs,
  [#85](https://github.com/ToguDV/masterhand/issues/85) out-of-band session cleanup.
- **Surface:** `packages/client-core/src/hooks.ts` (`usePreview`, `useSessionRun`), web
  `RunPanel`/`PreviewPanel` and `Composer.stop`, mobile `RunModal`/`PreviewModal`, server
  `runs.ts`, `preview.ts`, hub subscription in `app.ts`.
- **Why together:** one lifecycle (run starts the dev server on the reserved port; preview tunnels
  it); the client hooks and the server managers are used by both halves.
- **Order:** #84 → #85 → #89 → #73.
- **Dependencies:** none; #89 is a prerequisite of #99 and #97 expects #73/#89 landed first.

### C4 — BFF transport (opencode calls + SSE hub)

- **Issues:** [#75](https://github.com/ToguDV/masterhand/issues/75) deadline for every internal
  opencode call, [#76](https://github.com/ToguDV/masterhand/issues/76) hub stall watchdog,
  [#83](https://github.com/ToguDV/masterhand/issues/83) SSE backpressure.
- **Surface:** `apps/server/src/app.ts` (`callOpencode`, `/api/events`), `events.ts`.
- **Why together:** all three bound the same transport path (BFF ↔ opencode, BFF ↔ browser).
- **Order:** #75 → #76 → #83.
- **Dependencies:** #75 enables the long-operation budget used by #65 (C2).

### C5 — Storage and process resilience (BFF)

- **Issues:** [#88](https://github.com/ToguDV/masterhand/issues/88) crash guards, `app.onError`
  and health, [#86](https://github.com/ToguDV/masterhand/issues/86) degrade gracefully when
  writes fail, [#87](https://github.com/ToguDV/masterhand/issues/87) explicit storage conflicts
  (409/races), [#80](https://github.com/ToguDV/masterhand/issues/80) SQLite backup/restore and
  corruption recovery, [#91](https://github.com/ToguDV/masterhand/issues/91) auth restarts/clock
  jumps.
- **Surface:** `apps/server/src/index.ts`, `app.ts`, `store.ts`, `auth.ts`,
  `docs/runbooks/backups.md` (to create), `docs/bff/api.md`.
- **Why together:** all answer "what happens when storage or the process fails"; #88 creates the
  health/error channel that #86 and #80 surface to clients.
- **Order:** #88 → #86 → #87 → #80 → #91.
- **Notes:** #90 (C7) records the SQLite pragmas chosen while doing #86/#88.

### C6 — Worktrees and git

- **Issues:** [#79](https://github.com/ToguDV/masterhand/issues/79) non-destructive startup
  reconciliation, [#77](https://github.com/ToguDV/masterhand/issues/77) stop blocking the event
  loop with sync git/fs work, [#94](https://github.com/ToguDV/masterhand/issues/94) branch picker
  and creator (BFF endpoints + web UI).
- **Surface:** `apps/server/src/worktrees.ts` (`reconcileWorktrees`, `spawnSync`),
  `workspaces.ts`, `preview.ts` (`available()`), `index.ts`, `docs/bff/api.md`, composer branch chip.
- **Why together:** #79 and #77 rewrite the same runner and reconciliation; #94 builds its
  endpoints on the async runner (#77 first).
- **Order:** #79 → #77 → #94.
- **Notes:** #94 is the largest feature; it needs the existing timeout budget, busy-session and
  dirty-tree guards, and a `docs/past-mistakes.md` entry for the new non-idempotent mutations.

### C7 — Deploy/ops

- **Issues:** [#78](https://github.com/ToguDV/masterhand/issues/78) cap container logs and surface
  disk exhaustion, [#90](https://github.com/ToguDV/masterhand/issues/90) document the
  single-instance SQLite invariant and set container limits.
- **Surface:** `deploy/docker-compose.yml` (+ dev override), `ARCHITECTURE.md`, deployment runbook.
- **Why together:** compose/docs only, no application code; can be interleaved with any chunk.
- **Order:** #90 → #78 (or any).

### C8 — Web unified run/preview panel + bubble

- **Issues:** [#97](https://github.com/ToguDV/masterhand/issues/97) one Run & preview panel with
  internal tabs, [#98](https://github.com/ToguDV/masterhand/issues/98) recolor the user bubble to
  deep emerald.
- **Surface:** `apps/web/src/components/RunPanel.tsx`, `PreviewPanel.tsx`, `App.tsx`, `styles.css`,
  `design/DESIGN.md` + `design.css` + `DESIGN.html`.
- **Why together:** both are ink-on-paper UI adjustments in the same surfaces.
- **Order:** #98 (quick) → #97 (after C3's #73/#89).
- **Dependencies:** #97 needs #89 (and ideally #73) landed. #100 is the mobile counterpart of #98,
  blocked by C9.

### C9 — Mobile ink-on-paper and parity

- **Issues:** [#82](https://github.com/ToguDV/masterhand/issues/82) survive SecureStore failures,
  [#93](https://github.com/ToguDV/masterhand/issues/93) adopt the ink-on-paper design system,
  [#100](https://github.com/ToguDV/masterhand/issues/100) deep-emerald user bubble,
  [#92](https://github.com/ToguDV/masterhand/issues/92) port the compact composer layout,
  [#99](https://github.com/ToguDV/masterhand/issues/99) unify Run and Preview into one modal.
- **Surface:** `apps/mobile/src/theme.ts`, `App.tsx`, `storage.ts`,
  `components/Composer.tsx`/`MessageBubble.tsx`/`RunModal.tsx`/`PreviewModal.tsx`,
  `screens/ChatScreen.tsx`/`SessionsScreen.tsx`, `apps/mobile/test/*`.
- **Why together:** one component surface; #100 and #99 are consequences of #93 and the run/preview
  lifecycle work.
- **Order:** #82 → #93 → #100 → #92 → #99.
- **Dependencies:** #64 (C1) and #89 (C3). Do not start before both landed (explicit prerequisite
  in #99/#100).
