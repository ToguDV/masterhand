# WORKFLOW — MasterHand

How we develop, test and merge. Commit format details live in `CONTRIBUTING.md`.

## Principles

1. **One feature per branch and per PR.** No unrelated changes mixed in.
2. **Tests are part of the feature**, not a follow-up: unit tests for logic, end-to-end tests for user flows.
3. **Nothing is committed or merged while a gate is red.** `main` is always green.
4. **Squash merge** into `main`: one clean commit per feature.
5. **Finishing means shipping**: an agent that completes a task creates the branch, commits, pushes and opens the PR on its own. Do **not** ask for permission first; only stop to ask when the user explicitly requested a plan or a review with no changes.

## Branch model

- `main` is protected: no direct pushes, only pull requests.
- Branch names use the same prefixes as Conventional Commits:
  - `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>`, `test/<slug>`, `chore/<slug>`.
- Keep branches short-lived: branch → tests green → PR → squash → delete.

## Local loop

```bash
git switch -c feat/my-feature
# implement the feature and its tests
npm run test:coverage  # unit + coverage thresholds (fast feedback)
npm run test:e2e       # end-to-end
git add -A
git commit -m "feat(web): add my feature"   # pre-commit + commit-msg hooks run
git push                                    # pre-push hook runs the full gate
# open the PR using the template
```

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
- Coverage today: invalid login, the full flow login → new session → prompt → live stream → permission approval, workspaces, isolated sessions, model/effort/session preferences, subagents, semantic tool cards (shell/read/write/edit diffs), agent questions answered from an inline form, composer `/` command and `@` subagent popovers, `/btw` side questions, stalled-send recovery (client request deadline, retained text, "Sending…" feedback), session previews, upstream reconnection recovery, paged long conversations, markdown rendering, and the ink-on-paper design system (theme persistence, inline permission cards, choice modal for other-session questions).
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
- Merge with **Squash and merge** and delete the branch.

## Definition of done

- [ ] One feature, no unrelated changes.
- [ ] Unit tests cover the new logic; E2E covers the user flow.
- [ ] `npm run typecheck`, `npm run test:coverage`, `npm run test:e2e` and `npm run build` pass.
- [ ] `PROGRESS.md` and the affected docs are updated.
- [ ] PR approved and squash-merged into `main`.
