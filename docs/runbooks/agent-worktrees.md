# Agent worktrees — several agents on the same repo without stepping on each other

Two agents sharing one checkout will collide: the same `workspace/` and
`workspace/.worktrees/` directories, the same git `HEAD`, the same dev ports,
and test suites that shell out to `git`. The rule is simple: **one agent, one
git worktree, one branch**.

## Setup (main agent)

```bash
git fetch origin
git switch main && git pull --ff-only
git worktree add ../masterhand-<agent> -b fix/<slug> origin/main
git worktree list   # each agent has its own path + branch
```

Branch names follow `WORKFLOW.md` (`feat/<slug>`, `fix/<slug>`, …), one per
work session. Never check out the same branch in two worktrees.

## Running inside a worktree (every agent)

```bash
cd ../masterhand-<agent>
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE   # rule 30, also done by the hooks
git status --short --branch                  # only your own changes
npm run test:coverage -w @masterhand/server  # or the affected workspace
```

The git hooks scrub `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` automatically,
and the test helpers (`apps/server/test/git-async.test.ts`,
`scripts/ci-changes.test.mjs`) scrub them for every temp-repo `git` call, so a
leaked variable from a linked worktree cannot redirect a temp `git init` into
the real branch (the `Test <test@example.com>` incident).

Each agent commits and pushes only from its own worktree, staging only its
own files (`git add` on explicit paths, never `-A` on a shared checkout).

A fresh worktree has no `node_modules`, so the commit hooks fail there. Either
run `npm install` inside the worktree first, or bypass the hooks only for
throwaway test commits with `MASTERHAND_SKIP_HOOKS=1` (real work always keeps
the hooks enabled).

## What NOT to do

- Do not run two agents on the same checkout directory.
- Do not run `bash scripts/fdroid-repo.sh` locally: it checks out the orphan
  `fdroid` branch and empties the tree. It only runs in CI.
- Do not run gates with `GIT_DIR` (or `*_WORK_TREE`/`*_INDEX_FILE`) exported.
- The `tester` subagent never commits, checks out branches, or sets git
  identity (enforced by its permission denies): it reports production bugs in
  text and the main agent fixes them.

## Teardown

```bash
git worktree remove --force ../masterhand-<agent>
git worktree prune
git branch -D fix/<slug>   # after the PR is squash-merged
```

Stale branches whose upstream is gone (`git branch -vv` shows `gone`) are
deleted; `git worktree list` must show only live agents.
