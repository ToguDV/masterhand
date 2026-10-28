# Contributing to MasterHand

Thanks for your interest in contributing. MasterHand is open source and single-user by design (one user across multiple devices), so keep changes aligned with that scope.

## Language

- **Everything in English**: documentation, code comments, commit messages, issue/PR titles and identifiers.
- No non-English comments or user-facing strings.

## Commit conventions

MasterHand uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<scope>): <short description in imperative, lowercase>
```

Common types:

| Type | Use |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or fixing tests |
| `chore` | Build, tooling, dependencies |
| `perf` | Performance improvement |

Suggested scopes: `server`, `web`, `desktop`, `mobile`, `client-core`, `deploy`, `docs`.

Examples:

```
feat(web): add model selector to composer
fix(server): handle expired session token
docs(architecture): document Bearer token auth
```

Rules:

- Write the description in the imperative mood ("add", not "added").
- Keep the subject under ~72 characters.
- Use the body to explain *why* when it is not obvious; wrap at ~80 characters.
- Reference issues when relevant (`Refs #12`).

## Workflow

The full development flow (branches, test gates, E2E harness and merge strategy) lives in [`WORKFLOW.md`](WORKFLOW.md). In short:

- One branch and one PR per work session: a session may resolve several issues
  (one commit per issue, the PR body lists every `Closes #N`). Standalone
  hotfixes may still take their own branch.
- `pre-commit` runs typecheck + unit tests; `pre-push` and CI also run E2E and builds.
- `main` is protected; integrate with **squash merge** from a PR.

## Pull requests

1. Keep the session focused; no unrelated changes.
2. Fill the pull request template: what & why, changelog, how to review, testing, backward compatibility, client parity, code review, red → green trace, follow-ups, checklist.
3. Make sure `npm run typecheck`, `npm run test:coverage`, `npm run test:e2e` and `npm run build` pass (CI enforces them).
4. Update `PROGRESS.md` (status + dated changelog entry) when a task finishes.
5. Update the relevant documentation (`SPEC.md`, `ARCHITECTURE.md`, `docs/`) when scope, design or APIs change.
6. Use a Conventional Commits title; squash merge reuses it as the commit on `main`.

## Code style

- Strict TypeScript across the monorepo.
- Mobile-first: test every UI in a mobile viewport first.
- Clients never talk to `opencode serve` directly; everything goes through the BFF.
- Never commit secrets or API keys; use `.env` (git-ignored).

## Documentation

- APIs are documented **verified** against the server OpenAPI (`/doc`) or `types.gen.ts`, never from memory.
- New documents are indexed in `docs/README.md` and in `AGENTS.md`.
- Relevant technical decisions go in the ADR-lite table in `ARCHITECTURE.md`.
