# MasterHand — Project guide for agents

**What it is:** a self-hosted server that exposes your [opencode](https://opencode.ai) agents across web, desktop (Electron) and mobile (React Native). Open source, single-user across multiple devices — not multi-user. TLS is provided by whoever deploys it.

**Current status:** Phase 3 completed (`client-core` + web/desktop/mobile clients, device tokens). Next: Phase 4 (public release polish) and real-device verification. See `PROGRESS.md`.

## Documentation map

| Document | Content | When to update |
|---|---|---|
| `SPEC.md` | High-level spec: vision, scope, functional and non-functional requirements | When scope or requirements change |
| `ARCHITECTURE.md` | Architecture: components, flows, stack, security, decisions | When design or stack changes |
| `PROGRESS.md` | Status: done, in progress, pending, changelog | **When each task finishes** |
| `WORKFLOW.md` | Branch/test gates, PR and merge workflow | When the workflow changes |
| `CONTRIBUTING.md` | Commit/message conventions and contribution flow | When conventions change |
| `docs/README.md` | Index of specific documentation | When adding a new document |
| `design/DESIGN.md` | Design system: tokens, typography, components, responsive rules (getdesign format) + preview `design/DESIGN.html` | When the design system changes |
| `docs/opencode/` | Verified reference for opencode's API (SSE events, HTTP endpoints) | When integrating/verifying APIs |
| `docs/bff/` | MasterHand backend API (endpoints, auth, proxy) | When the BFF changes |
| `docs/runbooks/` | Operational procedures: host, deploy, TLS, backups | When operating or deploying |

### Maintenance rules

1. Every finished task is reflected in `PROGRESS.md` (status + dated changelog entry).
2. Every new document is indexed in `docs/README.md` and in the table above.
3. Relevant technical decisions are recorded in `ARCHITECTURE.md` (Decisions section).
4. Do not document APIs "from memory": verify against the server OpenAPI (`/doc`) or `types.generated.ts`.
5. Before finishing a task, run the gates (`npm run typecheck`, `npm run test:coverage`, `npm run test:e2e`, `npm run build`) and follow `WORKFLOW.md`.
6. Finishing a task **includes shipping it**: create the branch, commit, push and open the PR **without asking** (see `WORKFLOW.md` §"Finishing a task"). Asking first is only correct when the user explicitly asked for a plan/review only.

## Repository layout (target)

```
MasterHand/
├── apps/
│   ├── server/       # BFF: Node 22 + Hono (auth, proxy, SSE relay)
│   ├── web/          # Web: React 19 + Vite + TypeScript + Tailwind
│   ├── desktop/      # Desktop: Electron (wraps the web build)
│   └── mobile/       # Mobile: React Native + Expo
├── packages/
│   └── client-core/  # Shared API client, query hooks, SSE, auth adapters, types
├── deploy/           # docker-compose.yml, Dockerfiles, .env.example
├── docs/             # Specific documentation (APIs, runbooks, decisions)
├── README.md
├── AGENTS.md
├── CONTRIBUTING.md
├── LICENSE
├── SPEC.md
├── ARCHITECTURE.md
└── PROGRESS.md
```

## Commands

```bash
npm install            # install the whole monorepo (npm workspaces)

npm run dev            # Docker Compose dev stack: opencode + BFF + web/Vite (:5173)
npm run dev:server     # the same stack without Vite (BFF :8787)
npm run dev:desktop    # the Docker stack (detached) + Electron on the host
npm run dev:mobile     # the Docker stack (detached) + Expo dev server on the host
# Dev uses the deployment stack (deploy/docker-compose.yml) plus
# deploy/docker-compose.dev.yml (hot-reloading BFF/web) and deploy/.env.dev.
# The opencode image, sandbox, network, paths and env contract match production.
npm run dev:logs       # follow the stack logs
npm run dev:stop       # stop the stack (keeps volumes)
# Native fallback (no Docker, needs opencode v2 on PATH, apps/server/.env.local):
npm run dev:native:web # | dev:native:server | dev:native:desktop | dev:native:mobile
npm run dev:native:stop

npm run typecheck      # tsc across all workspaces
npm test               # vitest (server + client-core)
npm run test:e2e       # Playwright E2E (mocked opencode + BFF); npm run e2e:browsers once
npm run build          # production build (server + web + desktop)

# Deployment (host with Docker):
cp deploy/.env.example deploy/.env   # fill in secrets
docker compose -f deploy/docker-compose.yml up -d --build
```

## Conventions

- Strict TypeScript across the monorepo.
- **Everything in English**: documentation, code comments, commit messages, identifiers.
- **Conventional Commits** in English (e.g. `feat(web): add model selector`, `fix(server): handle expired token`). See `CONTRIBUTING.md`.
- **Mobile-first**: every UI is tested in a mobile viewport first.
- Clients **never** talk to `opencode serve` directly: everything goes through the BFF (see `ARCHITECTURE.md`).
- Never commit secrets or API keys; use `.env` (git-ignored).
- The opencode password (`OPENCODE_SERVER_PASSWORD`) lives only in the deploy host's `.env`, never in client code.

## Code minimalism (YAGNI ladder)

Build the least that satisfies the task. After reading the code the change touches and tracing the real flow, stop at the first rung that holds:

1. Does this need to exist? → no: skip it.
2. Already in this repo? → reuse it, don't rewrite.
3. Stdlib/runtime does it? → use it.
4. Native platform feature? → use it (e.g. `<input type="date">`, not a date-picker library).
5. Already-installed dependency? → use it.
6. One line? → one line.
7. Only then: the minimum that works.

Lazy about the solution, never about reading. This ladder **never** trims trust-boundary validation, error handling, security, accessibility, or data-loss handling.

It does **not** override deliberate architectural decisions: anything already justified in `SPEC.md` or `ARCHITECTURE.md` (BFF, `client-core`, device tokens, SQLite store, etc.) is out of scope for "do we need this?".

## External references

- opencode server: https://opencode.ai/docs/server/
- opencode SDK: https://opencode.ai/docs/sdk/
- opencode web: https://opencode.ai/docs/web/
- Types/events (source of truth): https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts
- OpenChamber (functional reference, MIT): https://github.com/openchamber/openchamber
