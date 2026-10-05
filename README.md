# MasterHand

Self-hosted server to use your [opencode](https://opencode.ai) agents from any device — web, desktop and mobile. Open source, single-user across multiple devices.

> Status: Phase 3 completed (BFF + web + Electron + React Native) and deploy-ready. Public release polish, host deployment and real-device testing are deferred. See `PROGRESS.md`.

## How it works

```
Web / Desktop (Electron) / Mobile (React Native)
        → your reverse proxy + TLS (Caddy, Nginx, Traefik, tunnel, ...)
        → MasterHand BFF
        → opencode serve
        → your agents
```

The BFF is the only bridge: clients never talk to opencode directly. TLS is left to whoever deploys the instance.

## Quick start (development)

Development runs the **same Docker Compose stack as a deployment** (opencode + BFF) plus a hot-reloading web front end, through the `deploy/docker-compose.dev.yml` override. The opencode container, its `agent-exec` sandbox, the internal network, the paths and the environment contract are identical to production; only the BFF (`tsx watch`) and web (Vite + HMR) run from source. Full guide: `docs/runbooks/development.md`.

```bash
npm install
cp deploy/.env.dev.example deploy/.env.dev   # optional: `npm run dev` creates it on first run

npm run dev           # opencode + BFF (:8787) + web/Vite (:5173)
npm run dev:server    # opencode + BFF only
npm run dev:desktop   # the Docker stack + Electron on the host
npm run dev:mobile    # the Docker stack + Expo dev server on the host
npm run dev:logs      # follow the stack logs
npm run dev:restart   # restart the BFF/Vite container (sources and data are kept)
npm run dev:stop      # stop the stack (volumes and data are kept)

npm test              # tests (vitest: BFF + client-core)
npm run test:e2e      # E2E (Playwright + mocked opencode); run `npm run e2e:browsers` once
```

The first `npm run dev` builds the images. `deploy/.env.dev` uses the **same variable names** as the production `deploy/.env.example` (see that file). Desktop and mobile cannot run in a container, so they run on the host against the containerized BFF (`http://localhost:8787`); they leave the stack running until `npm run dev:stop`.

To open the web app from a phone on the same network, publish Vite on all interfaces (`MASTERHAND_DEV_WEB_BIND=0.0.0.0` is the default) and browse to `http://<your-PC-IP>:5173`.

### Native fallback

The previous, fully native flow is still available when you do not want Docker (it needs `opencode` v2 on your `PATH` and uses `apps/server/.env.local`):

```bash
npm run dev:native:web       # opencode + BFF + web, all on the host
npm run dev:native:server
npm run dev:native:desktop
npm run dev:native:mobile
npm run dev:native:stop
```

## Deployment

Production runs the BFF and opencode as Docker Compose services and uses `deploy/.env`:

```bash
cp deploy/.env.example deploy/.env   # production secrets
docker compose -f deploy/docker-compose.yml up -d --build
```

Docker Compose reads `deploy/.env` and injects it into the containers; inside the network the BFF reaches opencode at `http://opencode:4096`. The development stack uses the same service name and network; only its env file (`deploy/.env.dev`) and the hot-reloading BFF/web differ. Then put your own reverse proxy / TLS in front of the published BFF port. See `docs/runbooks/deployment.md`.

## Stack

- **Web:** React 19 + Vite + TypeScript + Tailwind
- **Desktop:** Electron (loads the BFF-served web app; `MASTERHAND_URL`)
- **Mobile:** React Native + Expo
- **Shared:** `packages/client-core` (API client, query hooks, SSE, auth adapters)
- **BFF:** Node 22 + Hono (auth, proxy, SSE relay)
- **Engine:** `opencode serve` (pinned version)
- **Deploy:** Docker Compose (TLS provided by the deployer)

## Documentation

| Document | Content |
|---|---|
| `SPEC.md` | Vision, scope and requirements |
| `ARCHITECTURE.md` | Architecture, flows and decisions |
| `PROGRESS.md` | Status and changelog |
| `WORKFLOW.md` | Branch, test and PR workflow |
| `docs/` | Verified APIs and runbooks |
| `CONTRIBUTING.md` | Conventions and contribution guide |
| `AGENTS.md` | Guide for AI agents |

## License

MIT — see `LICENSE`.
