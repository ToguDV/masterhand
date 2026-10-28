# WORKFLOW — MasterHand

How we develop, test and merge. Commit format details live in `CONTRIBUTING.md`.

## Read this workflow first (mandatory)

Reading this document and `docs/past-mistakes.md` is **mandatory before making any change**: code, tests,
styles, configuration, dependencies, CI, docs, or repository housekeeping. No
exceptions, no "small change" shortcut, and no improvising around a rule.

- If a rule here conflicts with an ad-hoc request or looks inapplicable, stop
  and ask the user before proceeding.
- `AGENTS.md` points here and is binding for agents and humans alike; a change
  made without following this workflow is incomplete even if it works.
- Reading it again at the start of every session is cheap; skipping it is not.

## Principles

1. **Read this workflow and `docs/past-mistakes.md` before touching code.** Someone already paid for every lesson in that file — check the failure classes, rules and checklist against the task at hand so a known mistake is never reintroduced. Writing code first and reading it after defeats its purpose.
2. **One branch and one PR per work session.** A session may resolve several issues; they all ship in the **same branch**, with one commit per issue (each keeping its own red → green evidence) and a PR body that lists every `Closes #N`. Standalone hotfixes may still take their own branch. Batching matters for agent sessions in particular: one-PR-per-issue stacked 8 concurrent branches in a single session and forced repeated conflict resolution and CI runs on the shared docs (`PROGRESS.md`, `docs/past-mistakes.md`) plus a merge-order dance with the "branch up to date" protection.
3. **Test-driven, always.** Every behavioral change starts with a test that fails against current `main` for the right reason; then the minimum code to make it pass. Unit tests for logic, end-to-end tests for user flows. Tests are never a follow-up.
4. **Issues are hypotheses, not truth.** A published issue (or review finding) may be stale, wrong or already fixed. Reproduce it deterministically before implementing (see [Working from an issue](#working-from-an-issue-mandatory)).
5. **Every fix leaves a trace.** The failure class is recorded in `docs/past-mistakes.md` — a rule, a checklist item or an established pattern — so the same mistake cannot be reintroduced in another feature.
6. **Nothing is committed or merged while a gate is red.** `main` is always green.
7. **Squash merge** into `main`: one clean commit per PR. A session batch lands as a single squash commit (title = primary issue; the body carries the per-issue red → green evidence).
8. **Finishing means shipping**: an agent that completes a task creates the branch, commits, pushes and opens the PR on its own. Do **not** ask for permission first; only stop to ask when the user explicitly requested a plan or a review with no changes.

## Backward compatibility (before anything else)

MasterHand is deployed self-hosted with real data: the SQLite store (`/data`),
git worktrees plus isolated-session records, scheduled tasks and runs, device
tokens, provider config (`masterhand-providers.json`), preview-port reservations,
and workspace run configs and boards. Every change is therefore a change to a
live instance: it must never silently lose data, strand a worktree, lock out a
device, or force the deployer into an undocumented manual step.

Before writing code, tests or configuration, classify the change and answer two
questions in writing (to the user and in the PR):

1. **Is this a breaking change?**
2. **If it is, what is the migration and the rollback path?**

A change is **breaking** if, for an existing instance, database file, or an
already-registered client, it can:

- lose, damage or corrupt persisted rows (sessions, devices, scheduled tasks,
  preview ports, provider entries, boards, run configs) or their backups;
- make a database file that loads today fail to load, validate or migrate
  tomorrow (migrations are forward-only; v1/v2 are immutable — every later
  compatibility change appends a new version);
- remove, rename or reinterpret a persisted field, table, BFF endpoint, error
  shape or SSE frame without a compatible reader;
- break an older client against a newer BFF (the BFF API stays additive; new
  clients read old rows and old clients ignore unknown fields);
- require a manual step to keep working (wipe data, re-login every device,
  recreate workspaces, hand-edit config, rebuild outside the documented
  upgrade plan);
- rewrite migration history or stamp `user_version` inconsistently;
- remove or alter user-visible behavior that persisted state depends on.

Rules:

- **If the answer is yes — or you are not sure — tell the user before starting.**
  State what breaks, for whom, and the migration plus rollback you propose. Do
  not implement it until the user explicitly accepts the risk.
- **Default to forward-compatible, additive changes.** New fields, tables and
  endpoints ship with safe defaults; migrations run on boot, are idempotent,
  and cover every previously released version.
- **Never silently discard data.** On a parse/version/migration error, keep the
  original database intact, back it up before migrating, and surface a
  recoverable state instead of starting from scratch.
- **Any schema-version bump ships with** a migration from every previously
  released version, a test that opens a previous-release database file and
  asserts the upgrade preserves its data, an idempotency check, and the rollback
  path documented in the PR.
- Destructive-but-necessary host operations need an explicit, user-visible
  confirmation, never a silent background rewrite.
- Test with data from the previous release, not only with fresh databases.

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
- Keep branches short-lived: branch → tests green → PR → squash → delete. One branch per work session (Principle 2); do not open a new branch mid-session for another issue the same session resolves.

## Delivery order: contract first, then web, mobile, desktop verify

MasterHand ships a BFF plus `packages/client-core` plus three clients — web
(`apps/web`), desktop (`apps/desktop`, an Electron shell that serves the web
build) and mobile (`apps/mobile`, Expo). Every user-facing change must end with
real parity on all three; to prevent divergent implementations, follow this
order:

1. **Freeze the BFF + `client-core` contract first** (routes, error codes, SSE
   frames, hooks). Clients can start against the frozen contract or mock.
2. **Implement on web.** TDD applies; keep the change small and reviewable.
3. **Port the behavior to mobile.** Match interaction, copy, states, theme
   tokens (`apps/mobile/src/theme.ts`), accessibility (≥44px targets), and
   identity handling (SecureStore install id). Document native-only differences.
4. **Verify the behavior on desktop.** The shell serves the web build unchanged,
   so there is no separate UI to port; confirm the change works under the
   origin-locked navigation (`MASTERHAND_URL`) and the hardened renderer. If a
   change requires desktop-specific code in `apps/desktop/src`, treat it as a
   port with its own tests.
5. **Verify parity** (next section) and only then run the code review when one
   is required.

Parity is mandatory for anything that changes behavior or UI. Changes with no
plausible equivalent on a given client (native mobile storage/bridges, Electron
packaging, tooling, docs) are exempt **for that client only**: state the reason
in the PR under "Out of scope / follow-ups", and still check that no shared
`client-core` change alters behavior without every client being considered.

The whole session batch ships in **one branch and one PR** (Principle 2).
There is no intermediate approval gate between web and the ports: MasterHand
ships without asking unless the user explicitly requested a plan or review
with no changes.

## Parity verification (lightweight)

For user-facing changes, confirm that parity is real and not nominal:

- Build a parity table (behavior → web → mobile → desktop →
  equal/divergent): screens and navigation, copy (English), empty/loading/error
  states, theme (light/dark), accessibility (targets, focus), and persisted
  state shape.
- Audit `apps/web` and `apps/mobile` separately; web and desktop may be covered
  together because desktop renders the web build, but mobile must always be
  checked on its own. Use parallel subagents for large surfaces; trivial
  mechanical changes (copy tweak, one-line style fix, mechanical rename) may be
  verified by the main agent itself — say so in the PR.
- Fix the divergence, or record it as an accepted follow-up with the user. A
  documented platform-only difference is expected, not a divergence.
- **Do not finish while a functional divergence is open.**

## Code review (selective, mandatory for risky surfaces)

The global rule stays selective (see `AGENTS.md`: use the `code-reviewer`
subagent when it adds real value, not by default). A review is **mandatory**
when the change touches architecture, persistence or migrations, concurrency
or lifecycle (isolated sessions, Finish & PR, session/workspace deletion,
scheduler, runs/preview), the security or trust boundary (proxy allowlist, git
env/config sandbox, auth, provider targets), or deletion and cleanup paths.

Delegate to the `code-reviewer` subagent (read-only; it must not change code),
covering architecture and module boundaries per `ARCHITECTURE.md`,
cross-client consistency, the trust boundary, persistence and migrations plus
the backward-compatibility verdict above, tests at the right layer, and
simplicity (KISS/YAGNI) with leftover dead code. Fix the load-bearing findings,
re-run the gates, and report the remaining findings in the PR.

## Delegating long tasks to subagents

Use subagents when a task is too large for one pass — several screens, a whole
flow ported to mobile and verified on desktop, new test suites, or long
verification loops:

- Split by area (BFF, `client-core`, web UI, mobile UI, desktop shell, tests,
  docs) and run independent workers in parallel, while keeping the delivery
  order above (contract first, then web, then mobile and desktop).
- Give each worker its own context (files, acceptance criteria, TDD
  requirement); child sessions start empty.
- The main agent integrates the work, resolves conflicts, and owns the gates:
  never accept subagent output without running typecheck/tests.
- Trivial mechanical work (typos, one-line edits, renames) does not need a
  subagent.

## Trust-boundary awareness (mandatory for BFF work)

Every BFF change crosses a trust boundary. In addition to the failure classes
in `docs/past-mistakes.md`:

- Every operation that mutates server state is checked against
  `docs/past-mistakes.md` (deadlines, ambiguity, reconciliation, cleanup)
  before finishing. Non-idempotent mutations are never auto-retried.
- Do not document opencode APIs "from memory": verify against the server
  OpenAPI (`/doc`) or `types.generated.ts`.
- Managed runs stay sandboxed (the `agent-exec` launcher, verbatim argv, env
  allowlist); git never inherits `process.env`; tokens and passwords never
  reach client code, logs, or error responses.

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

## Real-stack verification (mandatory for behavior changes)

Green unit tests, a mocked E2E and a passing build are **regression checks, not
acceptance evidence**. Mocks cannot catch a stale build, a missing migration on
a real database file, a real 401/404/503, an origin/CORS violation, Docker env
drift, or a native bridge error hidden behind a generic client message. Before
reporting a behavior change as done, exercise the affected flow against the
real stack:

- Build the artifacts from the branch and run the real dev stack (`npm run dev`
  or `npm run dev:server` — the same Docker Compose stack as production plus
  the hot-reload override). Use a throwaway `DATA_DIR`/`WORKSPACES_ROOT`, never
  real instance data. Stop the stack when finished (see Agent cleanup).
- Run the exact commands the documentation tells the deployer or user to run
  and walk the complete flow, including failure paths: happy path,
  invalid/expired token, opencode unreachable, full-disk `503 storage_unavailable`,
  reload, and the relevant error states. Where state changes, check the
  persisted result (database row, status transition), not only the screen.
- Watch the browser/network console: unexpected 401/404/500/503, origin
  violations, and failed requests. A correct-looking screen with a console
  error is not done.
- Record the evidence in the PR: environment, commands, flows, database/state
  checks, console/network observations, and screenshots for UI changes. If a
  flow cannot be exercised locally, state exactly what was not verified and why.
  "The tests pass" or "the mocks cover it" is never enough.

This applies to any change that affects a user flow, auth, persistence or
migrations, build/serving, deploy configuration, or documentation that tells
someone to run a command. Small mechanical changes (typos, formatting, one-line
style fixes) are exempt.

## Agent cleanup (mandatory before finishing)

When an agent finishes a session, it **must leave the environment clean**:

- **No running stacks or servers.** Stop the dev stack (`npm run dev:stop` or
  `npm run dev:native:stop`) and any Vite/Electron/Expo/Playwright harness
  processes started during the session.
- **No leftover artifacts.** Remove temporary files, screenshots not meant to be
  committed, logs, and scratch data directories. Only commit intended changes.
- **No stray branches checked out.** Stay on the session branch while its PR is
  still open and awaiting review; otherwise return to `main`, with a clean
  working tree except for intended uncommitted work.
- **No untracked noise.** `git status` should show only intentional changes.
- Report the branch name and PR URL to the user, then stop.

## Finishing a task

When the implementation and its tests are done and the gates are green, **ship it without asking**:

1. `git switch -c <prefix>/<slug>` from an up-to-date `main` — **one branch for the whole session** (Principle 2). Commit each resolved issue separately on it with its own red → green evidence; the PR body lists all of them.
2. Check `git status` / `git diff`: stage only the intended files for this session's issues. Do not commit unrelated changes, secrets or generated artifacts.
3. Commit with a Conventional Commits message in English (the hooks will run the fast gate).
4. `git push -u origin <branch>` (the `pre-push` hook runs the full gate).
5. Open the PR against `main` with `gh pr create`, filling `.github/pull_request_template.md`, and return the PR URL.

Only skip this when the user explicitly asked for a plan, an analysis or a review with no changes.

## CI

`.github/workflows/ci.yml` runs on PRs to `main`, pushes to `main` and manual dispatches. A `changes` job classifies the diff (`scripts/ci-changes.mjs`, covered by `npm run test:scripts`; three-dot `base...head` on PRs, `before..after` on pushes) and the pipeline adapts:

- **Docs-only** (`**.md`, `docs/**`, `design/**`, `LICENSE`): only the gate runs — the required check passes in seconds.
- **Client changes**: typecheck, unit/coverage of the affected workspaces, dev-script tests when `scripts/` changed, the E2E **smoke** project for web/desktop changes, and the builds of the affected workspaces.
- **Critical changes** (`apps/server/**`, `packages/client-core/**`, `e2e/**`, dependency manifests, `.github/**`) and every push to `main`: the full pipeline (all unit suites + the complete E2E suite) plus the affected builds (`client-core` and dependency changes build every workspace; `e2e`-only and CI-only changes skip the build job — the E2E harness builds the web app itself).
- Any PR can force the full pipeline with the **`ci:full` label** (applies to an open PR without a new push).
- Every job restores `node_modules` from a single cache keyed by `package-lock.json` (one `npm ci` only on a miss) and the E2E jobs cache the Playwright browsers the same way — no repeated installs or downloads.

The required status check is **`CI gate`**: it always runs and fails when any job failed or was cancelled (skipped jobs are green). The classifier fails **open** — a missing or undiffable range, an unknown event, an empty diff or an unrecognized file all fall back to the full pipeline. Coverage and E2E artifacts are uploaded on failure. Never add trigger `paths:` filters: a required check that never reports blocks the merge. `scripts/ci-workflow.test.mjs` guards the gate wiring, the no-path-filters rule and the smoke list.

## Pull requests

- Use the title for the final commit; it must follow Conventional Commits (squash merge reuses it).
- Fill `.github/pull_request_template.md`:
  - **What & why** — the feature and its motivation.
  - **Changelog** — bullet list of changes.
  - **How to review** — exact steps the developer follows to approve.
  - **Testing** — gate results plus the real-stack verification evidence (or the
    explicit exemption for docs/formatting-only changes).
  - **Backward compatibility** — the verdict from §Backward compatibility:
    *not breaking*, or *breaking* with the approved migration, the rollback
    path, and the evidence that a previous-release database still loads.
  - **Client parity** — the parity table from §Parity verification, or the
    per-client exemptions when the change has no equivalent on a client.
  - **Code review** — the review outcome: findings fixed, and the ones left
    open as accepted follow-ups (or why no review was needed).
  - **Checklist** — the gates above plus docs/PROGRESS updates.
  - **Out of scope / follow-ups** — anything deliberately not addressed.
- Include the **red → green evidence** (the failing command and output before the fix, and the same command passing after) and the `docs/past-mistakes.md` update (or the explicit exemption for docs/formatting-only changes).
- Merge with **Squash and merge** and delete the branch.

## Session checklist (agent)

1. **Read this workflow** and `docs/past-mistakes.md`, and run the
   backward-compatibility check. If the change is breaking (or you are unsure),
   notify the user and wait for explicit approval before writing anything.
2. Create the session branch from an up-to-date `main`.
3. Reproduce the issue deterministically on current `main` (or document it as
   not reproducible and close/relabel it).
4. Freeze the reproduction as a failing test (red for the right reason), then
   implement the minimum until green: contract first, then web → mobile →
   desktop verify.
5. Verify client parity for user-facing changes; close the divergences.
6. Run the code review when §Code review requires it; fix the load-bearing
   findings.
7. Run all gates (`npm run typecheck`, `npm run test:coverage`,
   `npm run test:e2e`, `npm run build`) plus the real-stack verification for
   every affected flow. A mock-only pass does not close this step.
8. **Register any new/moved/deleted `.md` file** in `docs/README.md` and in the
   `AGENTS.md` documentation map in the same change. A doc without a reference
   there is incomplete.
9. Push the branch and open the single PR of the session; report branch + PR URL
   and await user review/merge.
10. Clean up: stop stacks/servers, remove scratch data directories and
    artifacts, verify `git status`.

## Definition of done

- [ ] This workflow was read at the start of the session.
- [ ] The backward-compatibility verdict is recorded in the PR (not breaking, or breaking with approved migration + rollback + previous-release evidence).
- [ ] The issue was reproduced deterministically before implementing (evidence in the PR), or documented as not reproducible and closed/relabeled.
- [ ] The failing test was written first (red for the right reason); the same command is green now.
- [ ] The failure class is recorded in `docs/past-mistakes.md` (rule/checklist/pattern), or the change is explicitly exempt (docs/formatting only).
- [ ] Client parity verified (table or per-client exemptions) for user-facing changes.
- [ ] Real-stack verification recorded (or the change is explicitly exempt as mechanical).
- [ ] Agent cleanup done (no running stacks, no scratch artifacts, `git status` clean).
- [ ] One session scope, no unrelated changes.
- [ ] Unit tests cover the new logic; E2E covers the user flow.
- [ ] `npm run typecheck`, `npm run test:coverage`, `npm run test:e2e` and `npm run build` pass.
- [ ] `PROGRESS.md` and the affected docs are updated.
- [ ] PR approved and squash-merged into `main`.
