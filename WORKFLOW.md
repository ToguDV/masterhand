# WORKFLOW — MasterHand

How we develop, test and merge. Commit format details live in `CONTRIBUTING.md`.

## Principles

1. **One feature per branch and per PR.** No unrelated changes mixed in.
2. **Test-driven, always.** Every behavioral change starts with a test that fails against current `main` for the right reason; then the minimum code to make it pass. Unit tests for logic, end-to-end tests for user flows. Tests are never a follow-up.
3. **Issues are hypotheses, not truth.** A published issue (or review finding) may be stale, wrong or already fixed. Reproduce it deterministically before implementing (see [Working from an issue](#working-from-an-issue-mandatory)).
4. **Every fix leaves a trace.** The failure class is recorded in `docs/past-mistakes.md` — a rule, a checklist item or an established pattern — so the same mistake cannot be reintroduced in another feature.
5. **Nothing is committed or merged while a gate is red.** `main` is always green.
6. **Squash merge** into `main`: one clean commit per feature.
7. **Finishing means shipping**: an agent that completes a task creates the branch, commits, pushes and opens the PR on its own. Do **not** ask for permission first; only stop to ask when the user explicitly requested a plan or a review with no changes.

## Working from an issue (mandatory)

A published issue is a **hypothesis**: it may be based on a stale revision, a misdiagnosis, or a scenario another change already fixed. Never implement an issue (or a review finding) directly.

1. **Locate the real code path.** Read the issue and the code it points at. If they contradict, comment on the issue with what the code actually does before writing anything.
2. **Reproduce it deterministically on current `main`.** A reproduction is a command, a unit/integration test, or an E2E step with a controlled mock that provokes the exact failure. A one-off manual observation is not enough.
3. **If it does not reproduce, do not "fix" it.** Comment the evidence, then close it or relabel it (`question`, `invalid`, `wontfix`). Split whatever turns out to be real into a new issue.
4. **Freeze the reproduction as a failing test (red).** That test is the definition of the bug: it must fail for the right reason against the pre-fix revision.
5. **Implement the minimum until green**, then refactor with the suite green.
6. **Record the failure class in `docs/past-mistakes.md`.** Add or update the rule, the checklist item and the established pattern so the same class cannot silently return in another feature. A fix without this trace is not done.
7. **Link the PR to the issue** (`Closes #N` when it fully resolves it, `Refs #N` otherwise) and update the issue if the diagnosis shifted.

Docs-only and formatting-only changes are exempt from the red test and the playbook trace (there is no behavior to reproduce); they still pass the gates.

## Branch model

- `main` is protected: no direct pushes, only pull requests.
- Branch names use the same prefixes as Conventional Commits:
  - `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>`, `test/<slug>`, `chore/<slug>`.
- Keep branches short-lived: branch → tests green → PR → squash → delete.

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
| `pre-push` (`.githooks/pre-push`) | typecheck + unit/coverage + E2E + builds | Full local mirror of CI before sharing the branch |
| GitHub Actions (`.github/workflows/ci.yml`) | typecheck + unit/coverage + E2E + build | Required check on every PR to `main` |

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
- Harness: `e2e/mock-opencode.ts` (fake `opencode serve`) + the real BFF serving the built web app, driven in a browser.
- Ports: mock `4097`, BFF `8788` (no conflict with a local `npm run dev`).
- Run: `npm run test:e2e`. Debug interactively: `npm run test:e2e -w @masterhand/e2e -- --ui`.
- Coverage today: invalid login, the full flow login → new session → prompt → live stream → permission approval, workspaces, isolated sessions, model/effort/session preferences, subagents, semantic tool cards (shell/read/write/edit diffs), agent questions answered from an inline form, composer `/` command and `@` subagent popovers, `/btw` side questions, stalled-send recovery (history-confirmed early release, request-deadline fallback, retained text, "Sending…" feedback), session previews, upstream reconnection recovery, paged long conversations, markdown rendering, and the ink-on-paper design system (theme persistence, inline permission cards, choice modal for other-session questions).
- Add one spec under `e2e/tests/` per user-facing flow.

## Finishing a task

When the implementation and its tests are done and the gates are green, **ship it without asking**:

1. `git switch -c <prefix>/<slug>` from an up-to-date `main`.
2. Check `git status` / `git diff`: stage only the intended files, one feature per branch. Do not commit unrelated changes, secrets or generated artifacts.
3. Commit with a Conventional Commits message in English (the hooks will run the fast gate).
4. `git push -u origin <branch>` (the `pre-push` hook runs the full gate).
5. Open the PR against `main` with `gh pr create`, filling `.github/pull_request_template.md`, and return the PR URL.

Only skip this when the user explicitly asked for a plan, an analysis or a review with no changes.

## CI

`.github/workflows/ci.yml` runs on every PR and push to `main`: install, typecheck, unit + coverage, E2E and build. Coverage and E2E artifacts are uploaded on failure. A red check blocks the merge.

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
