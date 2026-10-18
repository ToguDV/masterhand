# WORKFLOW — MasterHand

How we develop, test and merge. Commit format details live in `CONTRIBUTING.md`.

## Principles

1. **Read `docs/past-mistakes.md` before touching code.** Someone already paid for every lesson in that file — check the failure classes, rules and checklist against the task at hand so a known mistake is never reintroduced. Writing code first and reading it after defeats its purpose.
2. **One branch and one PR per work session.** A session may resolve several issues; they all ship in the **same branch**, with one commit per issue (each keeping its own red → green evidence) and a PR body that lists every `Closes #N`. Standalone hotfixes may still take their own branch. Batching matters for agent sessions in particular: one-PR-per-issue stacked 8 concurrent branches in a single session and forced repeated conflict resolution and CI runs on the shared docs (`PROGRESS.md`, `docs/past-mistakes.md`) plus a merge-order dance with the "branch up to date" protection.
3. **Test-driven, always.** Every behavioral change starts with a test that fails against current `main` for the right reason; then the minimum code to make it pass. Unit tests for logic, end-to-end tests for user flows. Tests are never a follow-up.
4. **Issues are hypotheses, not truth.** A published issue (or review finding) may be stale, wrong or already fixed. Reproduce it deterministically before implementing (see [Working from an issue](#working-from-an-issue-mandatory)).
5. **Every fix leaves a trace.** The failure class is recorded in `docs/past-mistakes.md` — a rule, a checklist item or an established pattern — so the same mistake cannot be reintroduced in another feature.
6. **Nothing is committed or merged while a gate is red.** `main` is always green.
7. **Squash merge** into `main`: one clean commit per PR. A session batch lands as a single squash commit (title = primary issue; the body carries the per-issue red → green evidence).
8. **Finishing means shipping**: an agent that completes a task creates the branch, commits, pushes and opens the PR on its own. Do **not** ask for permission first; only stop to ask when the user explicitly requested a plan or a review with no changes.

## Working from an issue (mandatory)

A published issue is a **hypothesis**: it may be based on a stale revision, a misdiagnosis, or a scenario another change already fixed. Never implement an issue (or a review finding) directly.

1. **Locate the real code path.** Read the issue and the code it points at. If they contradict, comment on the issue with what the code actually does before writing anything.
2. **Reproduce it deterministically on current `main`.** A reproduction is a command, a unit/integration test, or an E2E step with a controlled mock that provokes the exact failure. A one-off manual observation is not enough.
3. **If it does not reproduce, do not "fix" it.** Comment the evidence, then close it or relabel it (`question`, `invalid`, `wontfix`). Split whatever turns out to be real into a new issue.
4. **Freeze the reproduction as a failing test (red).** That test is the definition of the bug: it must fail for the right reason against the pre-fix revision.
5. **Implement the minimum until green**, then refactor with the suite green.
6. **Record the failure class in `docs/past-mistakes.md`.** Add or update the rule, the checklist item and the established pattern so the same class cannot silently return in another feature. A fix without this trace is not done.
7. **Link the PR to every issue it resolves** (`Closes #N` per issue, `Refs #N` otherwise) and update any issue whose diagnosis shifted.

Docs-only and formatting-only changes are exempt from the red test and the playbook trace (there is no behavior to reproduce); they still pass the gates.

## Branch model

- `main` is protected: no direct pushes, only pull requests.
- Branch names use the same prefixes as Conventional Commits:
  - `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>`, `test/<slug>`, `chore/<slug>`.
- Keep branches short-lived: branch → tests green → PR → squash → delete. One branch per work session (Principle 1); do not open a new branch mid-session for another issue the same session resolves.

## Local loop (TDD)

```bash
git switch -c fix/my-fix
# 1. Reproduce the issue deterministically and confirm it fails on the pre-fix code
# 2. Turn the reproduction into a test and confirm it is RED for the right reason
#    npm run test:coverage -w <workspace>
#    npm run test:e2e -w @masterhand/e2e -- tests/my.spec.ts
# 3. Implement the minimum until GREEN, then refactor with the suite green
npm run test:coverage  # unit + coverage thresholds (fast feedback)
npm run test:e2e       # end-to-end
git add -A
git commit -m "fix(web): ..."   # pre-commit + commit-msg hooks run
git push                        # pre-push hook runs the full gate
# open the PR using the template, with the red → green evidence
```

Keep the **red → green evidence** in the PR: the exact command, the failure observed before the fix, and the same command passing after.

## Gates

| Gate | Runs | Purpose |
|---|---|---|
| `pre-commit` (`.githooks/pre-commit`) | `npm run typecheck` + `npm run test:coverage` + `npm run test:scripts` | Fast: never commit broken types, failing unit tests or uncovered code |
| `commit-msg` (`.githooks/commit-msg`) | Conventional Commits check | Keep an English, standard history |
| `pre-push` (`.githooks/pre-push`) | typecheck + unit/coverage + E2E + builds | Full local gate before sharing the branch (CI then runs the diff-aware subset — see §CI) |
| GitHub Actions (`.github/workflows/ci.yml`) | diff-aware via `scripts/ci-changes.mjs`: docs-only → gate only; client changes → typecheck + affected unit/coverage + smoke E2E; critical paths (`server`, `client-core`, `e2e`, dependency manifests, CI), pushes to `main` or label `ci:full` → full suite | Required check on every PR to `main` (`CI gate`) |

Emergency bypass (use sparingly, never for `main`): `MASTERHAND_SKIP_HOOKS=1 git commit ...`.

## Setup (once per clone)

```bash
npm install              # the `prepare` script runs `git config core.hooksPath .githooks`
npm run e2e:browsers     # downloads the Chromium used by Playwright
```

## Unit tests

- Locations: `apps/server/test`, `packages/client-core/test` and `apps/mobile/test` (vitest); `scripts/*.test.mjs` (Node's built-in runner).
- Run all: `npm test`. Watch a workspace: `npm run test:watch -w @masterhand/server`. Dev scripts: `npm run test:scripts`.

## Coverage gate

- Run: `npm run test:coverage` (vitest v8, `lcov` + `text`).
- Enforced with an **80% threshold** on lines, statements, branches and functions in `apps/server` and `packages/client-core` (the two libraries with tests). `apps/web`, `mobile`, `desktop` and `e2e` are out of scope: their UI/flows are validated by E2E, not by a percentage.
- `apps/mobile` still runs its (small) suite in the same gate — `test:coverage` maps to `vitest run`, with no threshold — because native-only defects (DOM-absence crashes, deprecated React Native APIs) cannot be reached by the browser E2E suite.
- Entry points (`src/index.ts`) and type-only modules (`src/types.ts`) are excluded; there is no other exclusion.
- React hooks in `client-core` are tested with `@testing-library/react` (`renderHook`) under a jsdom environment; the rest of that package is plain Node.
- CI and the git hooks fail when a threshold is not met; the `lcov` report is uploaded as an artifact on failure.

## End-to-end tests

- Workspace `e2e/`, built with [Playwright](https://playwright.dev).
- Harness: `e2e/mock-opencode.ts` (fake `opencode serve`) + the real BFF serving the built web app, driven in a browser. Both are spawned **per worker** by the worker-scoped `harness` fixture (`e2e/fixtures.ts`) on ports derived from the worker index (`e2e/paths.ts`: mock `4097+N`, BFF `8788+N`, preview pool = the worker's mock port) with per-worker `DATA_DIR`, `WORKSPACES_ROOT` and cloudflared die file — so the process-global `/e2e/*` mock controls and the app-global session UI stay inside one worker. `baseURL` comes from the fixture (never the shared config); `globalSetup` builds the web app once per run and wipes the scratch root.
- Two Playwright projects: **`smoke`** (`SMOKE_SPECS` in `e2e/playwright.config.ts` — the critical flows CI runs for client-only changes) and **`full`** (every other spec). Running without `--project` executes both, i.e. every spec exactly once; `npm run test:e2e -w @masterhand/e2e -- --project=smoke` runs only the critical flows.
- Run: `npm run test:e2e` (`workers: 4`, capped by `E2E_MAX_WORKERS`). Debug interactively: `npm run test:e2e -w @masterhand/e2e -- --ui`.
- A killed run is reclaimed by `e2e/cleanup-ports.mjs` before Playwright boots: it frees the whole reserved block (`4097..4104`, `8788..8795` — no conflict with a local `npm run dev`: opencode `4096`, BFF `8787`, Vite `5173`) and wipes the scratch root, and each worker wipes its own dir before spawning its servers. The historical pinned `workers: 1` (and its measured cross-worker-collision rationale) was removed by per-worker isolation ([#175](https://github.com/ToguDV/masterhand/issues/175)): verified 2026-10-17 with the full suite (103 tests) at `--workers=4` twice back-to-back — 103 passed / 0 flaky in 58s and 57s (179s at `workers: 1`) — plus a SIGKILL drill whose orphans the next run reclaimed. A spec that arms a process-global mock control still resets it in `afterEach` — the controls are global within a worker.
- Coverage today: invalid login, the full flow login → new session → prompt → live stream → permission approval, workspaces, isolated sessions, branch picker/creator (search + switch + create, read-only chip for isolated), model/effort/session preferences, subagents, semantic tool cards (shell/read/write/edit diffs), agent questions answered from an inline form, composer `/` command and `@` subagent popovers, `/btw` side questions, stalled-send recovery (history-confirmed early release, request-deadline fallback, retained text, "Sending…" feedback), session previews, run/preview death notices, the unified Run & preview panel (tab switching, auto-landing on Preview, one trigger), a lost Finish & PR response (ambiguity + safe retry), a failed Stop, an ambiguous permission reply confirmed by reconciliation, upstream reconnection recovery, paged long conversations, markdown rendering, and the ink-on-paper design system (theme persistence, deep-emerald user bubble, inline permission cards, choice modal for other-session questions).
- Add one spec under `e2e/tests/` per user-facing flow.

## Finishing a task

When the implementation and its tests are done and the gates are green, **ship it without asking**:

1. `git switch -c <prefix>/<slug>` from an up-to-date `main` — **one branch for the whole session** (Principle 1). Commit each resolved issue separately on it with its own red → green evidence; the PR body lists all of them.
2. Check `git status` / `git diff`: stage only the intended files for this session's issues. Do not commit unrelated changes, secrets or generated artifacts.
3. Commit with a Conventional Commits message in English (the hooks will run the fast gate).
4. `git push -u origin <branch>` (the `pre-push` hook runs the full gate).
5. Open the PR against `main` with `gh pr create`, filling `.github/pull_request_template.md`, and return the PR URL.

Only skip this when the user explicitly asked for a plan, an analysis or a review with no changes.

## CI

`.github/workflows/ci.yml` runs on PRs to `main`, pushes to `main` and manual dispatches. A `changes` job classifies the diff (`scripts/ci-changes.mjs`, covered by `npm run test:scripts`; three-dot `base...head` on PRs, `before..after` on pushes) and the pipeline adapts:

- **Docs-only** (`**.md`, `docs/**`, `design/**`, `LICENSE`): only the gate runs — the required check passes in seconds.
- **Client changes**: typecheck, unit/coverage of the affected workspaces, dev-script tests when `scripts/` changed, the E2E **smoke** project and the builds.
- **Critical changes** (`apps/server/**`, `packages/client-core/**`, `e2e/**`, dependency manifests, `.github/**`) and every push to `main`: the full pipeline (all unit suites + the complete E2E suite) plus the builds.
- Any PR can force the full pipeline with the **`ci:full` label** (applies to an open PR without a new push).

The required status check is **`CI gate`**: it always runs and fails when any job failed or was cancelled (skipped jobs are green). The classifier fails **open** — a missing or undiffable range, an unknown event, an empty diff or an unrecognized file all fall back to the full pipeline. Coverage and E2E artifacts are uploaded on failure. Never add trigger `paths:` filters: a required check that never reports blocks the merge. `scripts/ci-workflow.test.mjs` guards the gate wiring, the no-path-filters rule and the smoke list.

## Pull requests

- Use the title for the final commit; it must follow Conventional Commits (squash merge reuses it).
- Fill `.github/pull_request_template.md`:
  - **What & why** — the single feature and its motivation.
  - **Changelog** — bullet list of changes.
  - **How to review** — exact steps the developer follows to approve.
  - **Checklist** — the gates above plus docs/PROGRESS updates.
- Include the **red → green evidence** (the failing command and output before the fix, and the same command passing after) and the `docs/past-mistakes.md` update (or the explicit exemption for docs/formatting-only changes).
- Merge with **Squash and merge** and delete the branch.

## Definition of done

- [ ] The issue was reproduced deterministically before implementing (evidence in the PR), or documented as not reproducible and closed/relabeled.
- [ ] The failing test was written first (red for the right reason); the same command is green now.
- [ ] The failure class is recorded in `docs/past-mistakes.md` (rule/checklist/pattern), or the change is explicitly exempt (docs/formatting only).
- [ ] One feature, no unrelated changes.
- [ ] Unit tests cover the new logic; E2E covers the user flow.
- [ ] `npm run typecheck`, `npm run test:coverage`, `npm run test:e2e` and `npm run build` pass.
- [ ] `PROGRESS.md` and the affected docs are updated.
- [ ] PR approved and squash-merged into `main`.
