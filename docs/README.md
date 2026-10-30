# MasterHand documentation

Index of specific documentation (APIs, runbooks, decisions). High-level documentation lives at the repository root: `SPEC.md`, `ARCHITECTURE.md`, `PROGRESS.md`.

## Rules

1. Every new document in this folder is indexed here.
2. APIs are documented **verified** (against the server OpenAPI at `/doc` or `types.generated.ts`), never from memory.
3. Include a verification date in every API document.

## Index

| Document | Content | Status |
|---|---|---|
| [`../design/DESIGN.md`](../design/DESIGN.md) | Design system: tokens, typography, components, responsive rules (getdesign format); preview in `design/DESIGN.html` | ✅ 2026-10-12 |
| [`opencode/events.md`](opencode/events.md) | opencode SSE event types (verified) and which ones MasterHand consumes | ✅ 2026-10-03 |
| [`opencode/http-api.md`](opencode/http-api.md) | opencode HTTP endpoints relevant to MasterHand | ✅ 2026-10-20 |
| [`bff/api.md`](bff/api.md) | MasterHand BFF API (auth, proxy, SSE relay) | ✅ 2026-10-20 |
| [`past-mistakes.md`](past-mistakes.md) | Past reliability mistakes: failure classes, rules and checklist for client changes | ✅ 2026-10-20 |
| [`plans/issue-chunks.md`](plans/issue-chunks.md) | Batched follow-up plan: the open issues grouped in 7 chunks by shared code surface, with order and dependencies per chunk | 🔄 2026-10-20 |
| [`runbooks/development.md`](runbooks/development.md) | Development with the deployment Docker Compose stack (hot reload) | ✅ 2026-10-20 |
| [`runbooks/deployment.md`](runbooks/deployment.md) | Deployment with Docker Compose and TLS options for the deployer | ✅ 2026-10-20 |
| [`runbooks/backups.md`](runbooks/backups.md) | Volume backups, online SQLite backup, restore and corruption behavior | ✅ 2026-10-05 |
| [`runbooks/mobile-e2e.md`](runbooks/mobile-e2e.md) | Mobile E2E with Maestro (emulator/simulator and CI) | ✅ 2026-10-01 |
| [`runbooks/fdroid.md`](runbooks/fdroid.md) | Self-hosted F-Droid repo and Android update notices (#133) | ✅ 2026-10-29 |
| [`runbooks/release.md`](runbooks/release.md) | Cutting a release: version guard, server image, Android APK/F-Droid, desktop installers, rollback and the opt-in BFF updater | ✅ 2026-10-29 |
| [`runbooks/agent-worktrees.md`](runbooks/agent-worktrees.md) | One worktree + branch per agent: setup, gates without a `GIT_DIR` leak, teardown | ✅ 2026-10-30 |
| [`reviews/2026-10-01-pr-24-25-code-review.md`](reviews/2026-10-01-pr-24-25-code-review.md) | Code review of PR #24/#25: open findings, evidence and fix plan | ✅ 2026-10-01 |
| `runbooks/host-setup.md` | Host preparation: Docker, DNS, user and firewall | ⬜ Phase 0 |
