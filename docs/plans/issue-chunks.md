# Issue chunks — batched follow-up plan

**Snapshot:** 2026-10-07. 5 open issues (#129–#131, #133–#134) grouped into **3 chunks**
(C14–C16) by the code surface they share. The previous backlog (C1–C13) is fully merged or closed.

**Last updated:** 2026-10-09 — C14 (goal mode) is in review as the session batch
(#129 + #130) together with the shared opencode retry engine it relies on (ADR-32).
The previous note (2026-10-07) recorded C11 landing in the theme-system session batch
(Android nav bar, 12 accent palettes, syntax highlighting). Stale trackers already shipped in #135
(#120, #122, #125–#128) were closed as completed; #121 was closed as not planned (sign-out stays in
the sessions options box per #136/#137). Re-chunked after the issue batch created from the maintainer's
mobile/web review: #118 Android nav bar; #119–#122 settings hub and header cleanup; #123–#124
syntax highlighting and color themes; #125–#127 chat feedback, per-message stats and the tok/s
fix; #128 provider credentials; #129–#130 `/goal`; and the release/update work, split after the
F-Droid and GHCR decisions into #131 (A: versioning, GHCR images, BFF update check, web/desktop),
#133 (B: self-hosted F-Droid repo + Android notice) and #134 (standardized one-click BFF updater,
deferred).

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
| C14 — /goal (server + clients) | #129 #130 | 🟡 In review — session batch (goal mode + shared retry engine) |
| C15 — Releases and in-app updates | #131 #133 | ⬜ Pending |
| C16 — Standardized BFF updater (deferred) | #134 | ⬜ Pending |

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

**Highest severity in the queue:** none open — the largest feature is **/goal** (C14), followed
by the release/update system (C15). Suggested batch order: **C14 → C15 → C16** — C16 is deferred
(opt-in). C15's foundation (#131: versioning + GHCR + the update endpoint) has no hard blocker
beyond the settings section and can be pulled earlier.

## Chunks — current batch (C14–C16)

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
