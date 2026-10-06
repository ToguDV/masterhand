# Issue chunks — batched follow-up plan

**Snapshot:** 2026-10-05. The 34 open issues at that date, grouped into **9 chunks** by the code
surface they share, so a chunk can be implemented in one work session without changing context.

**Last updated:** 2026-10-05 — session batch #107–#114 merged (#79, #75, #76, #83, #81, #69, #66,
#70); workflow switched to one branch per session. Then the lifecycle session batch closed C2/C3
(#84, #85, #89, #73, #67, #65), C5 (#88, #86, #87, #80, #91) and interleaved C7 (#78, #90) in PR #116.
The remaining-issues session batch closed C6 (#77, #94), C8 (#97, #98) and C9 (#82, #93, #100, #92,
#99) — the 34-issue backlog is empty.

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

**Highest severity in the queue:** the trio [#85](https://github.com/ToguDV/masterhand/issues/85),
[#84](https://github.com/ToguDV/masterhand/issues/84) and
[#65](https://github.com/ToguDV/masterhand/issues/65) landed 2026-10-05 in the lifecycle session
batch, together with C2, C5 and C7. **All chunks are now closed**: the remaining-issues session
batch finished C6 ([#77](https://github.com/ToguDV/masterhand/issues/77) async git runner,
[#94](https://github.com/ToguDV/masterhand/issues/94) branch picker), C8
([#98](https://github.com/ToguDV/masterhand/issues/98) bubble,
[#97](https://github.com/ToguDV/masterhand/issues/97) unified Run & preview panel) and C9
([#82](https://github.com/ToguDV/masterhand/issues/82),
[#93](https://github.com/ToguDV/masterhand/issues/93),
[#100](https://github.com/ToguDV/masterhand/issues/100),
[#92](https://github.com/ToguDV/masterhand/issues/92),
[#99](https://github.com/ToguDV/masterhand/issues/99)).

## Chunks

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
