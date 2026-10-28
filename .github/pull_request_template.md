## What & why

<!-- One feature per PR. What does it change and why? -->

## Changelog

-

## How to review

<!-- Exact steps the developer must follow to approve this PR. -->
1.
2.

## Testing

<!-- Gate results + real-stack verification evidence (WORKFLOW.md), or the explicit exemption for docs/formatting-only changes. -->
- [ ] `npm run typecheck` —
- [ ] `npm run test:coverage` —
- [ ] `npm run test:e2e` —
- [ ] `npm run build` —
- [ ] Real-stack verification —

## Backward compatibility

<!-- WORKFLOW.md §Backward compatibility verdict: not breaking, or breaking with the approved migration + rollback + previous-release evidence. -->

## Client parity

<!-- WORKFLOW.md §Parity verification table (behavior → web → mobile → desktop), or per-client exemptions. -->

## Code review

<!-- WORKFLOW.md §Code review outcome: findings fixed + accepted follow-ups, or why no review was needed. -->

## Red → green and past-mistakes trace

<!-- Failing command/output before the fix, same command passing after, and the docs/past-mistakes.md update (or the docs/formatting-only exemption). -->

## Out of scope / follow-ups

<!-- Anything deliberately not addressed. -->

## Checklist

- [ ] One feature only (no unrelated changes)
- [ ] `npm run typecheck` passes
- [ ] `npm run test:coverage` passes (unit + 80% coverage gate)
- [ ] `npm run test:e2e` passes (E2E)
- [ ] `npm run build` passes
- [ ] Docs updated (`README.md`, `ARCHITECTURE.md`, `PROGRESS.md`, `docs/`)
- [ ] PR title uses Conventional Commits (squash merge uses it as the commit)
