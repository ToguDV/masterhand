# MasterHand documentation

Index of specific documentation (APIs, runbooks, decisions). High-level documentation lives at the repository root: `SPEC.md`, `ARCHITECTURE.md`, `PROGRESS.md`.

## Rules

1. Every new document in this folder is indexed here.
2. APIs are documented **verified** (against the server OpenAPI at `/doc` or `types.generated.ts`), never from memory.
3. Include a verification date in every API document.

## Index

| Document | Content | Status |
|---|---|---|
| [`../design/DESIGN.md`](../design/DESIGN.md) | Design system: tokens, typography, components, responsive rules (getdesign format); preview in `design/DESIGN.html` | ✅ 2026-10-04 |
| [`opencode/events.md`](opencode/events.md) | opencode SSE event types (verified) and which ones MasterHand consumes | ✅ 2026-10-03 |
| [`opencode/http-api.md`](opencode/http-api.md) | opencode HTTP endpoints relevant to MasterHand | ✅ 2026-09-27 |
| [`bff/api.md`](bff/api.md) | MasterHand BFF API (auth, proxy, SSE relay) | ✅ 2026-09-27 |
| [`past-mistakes.md`](past-mistakes.md) | Past reliability mistakes: failure classes, rules and checklist for client changes | ✅ 2026-10-05 |
| [`runbooks/development.md`](runbooks/development.md) | Development with the deployment Docker Compose stack (hot reload) | ✅ 2026-10-04 |
| [`runbooks/deployment.md`](runbooks/deployment.md) | Deployment with Docker Compose and TLS options for the deployer | ✅ 2026-09-27 |
| [`runbooks/mobile-e2e.md`](runbooks/mobile-e2e.md) | Mobile E2E with Maestro (emulator/simulator and CI) | ✅ 2026-10-01 |
| [`reviews/2026-10-01-pr-24-25-code-review.md`](reviews/2026-10-01-pr-24-25-code-review.md) | Code review of PR #24/#25: open findings, evidence and fix plan | ✅ 2026-10-01 |
| `runbooks/host-setup.md` | Host preparation: Docker, DNS, user and firewall | ⬜ Phase 0 |
| `runbooks/backups.md` | Volume backups (sessions, config, devices) and restore | ⬜ Phase 5 |
